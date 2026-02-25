// dc911-proxy — Deschutes County 911 CadView → HOSCAD ingest bridge
//
// Fetches active calls + units from a NewWorld CadView instance and POSTs
// normalized data to the HOSCAD Supabase Edge Function (dc911Ingest action).
//
// Phase 1: Unauthenticated read of public CadView instances (for testing).
// Phase 2: OIDC Implicit Flow auth with chromedp for production DC911.
//
// Environment variables (set as GitHub Actions secrets):
//   DC911_CADVIEW_URL   — CadView base URL (e.g. "https://cadview.qvec.org/NewWorld.CadView")
//   DC911_HOSCAD_URL    — Supabase Edge Function URL
//   DC911_SECRET        — Shared secret matching Supabase DC911_SECRET env var
//
// Usage: runs as a single poll per invocation (GitHub Actions cron handles repeat).

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// API types — CadView response shapes
// ---------------------------------------------------------------------------

// CadView /api/Call/GetActiveCalls response item (field names vary by instance)
type rawCall map[string]interface{}

// CadView /api/Call/GetCallUnits?id=X response item
type rawUnit map[string]interface{}

// ---------------------------------------------------------------------------
// Normalized types — sent to HOSCAD dc911Ingest
// ---------------------------------------------------------------------------

type dc911Unit struct {
	ID         string `json:"id"`
	Status     string `json:"status"`
	AgencyType string `json:"agencyType,omitempty"`
}

type dc911Call struct {
	ID         string      `json:"id"`
	Type       string      `json:"type"`
	Address    string      `json:"address"`
	AgencyType string      `json:"agencyType"`
	Units      []dc911Unit `json:"units"`
}

type ingestPayload struct {
	Calls []dc911Call `json:"calls"`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	cadviewURL := mustEnv("DC911_CADVIEW_URL")
	hoscadURL  := mustEnv("DC911_HOSCAD_URL")
	secret     := mustEnv("DC911_SECRET")

	log.Printf("[dc911-proxy] polling %s", cadviewURL)

	calls, err := fetchActiveCalls(cadviewURL)
	if err != nil {
		// Non-fatal: CadView may be temporarily unavailable or require credentials.
		// Log the error and exit cleanly — GHA cron will retry in 5 minutes.
		// WAITING FOR DC911 MOU: replace DC911_CADVIEW_URL with credentialed endpoint.
		log.Printf("[dc911-proxy] WARNING: fetchActiveCalls failed (MOU/credentials needed?): %v", err)
		log.Printf("[dc911-proxy] no data ingested this cycle — will retry next run")
		return
	}

	log.Printf("[dc911-proxy] fetched %d active calls", len(calls))

	if err := ingest(hoscadURL, secret, ingestPayload{Calls: calls}); err != nil {
		log.Printf("[dc911-proxy] WARNING: ingest failed: %v", err)
		return
	}

	log.Printf("[dc911-proxy] done")
}

// ---------------------------------------------------------------------------
// Fetch active calls from CadView
// ---------------------------------------------------------------------------

func fetchActiveCalls(baseURL string) ([]dc911Call, error) {
	client := &http.Client{Timeout: 30 * time.Second}

	// GET /api/Call/GetActiveCalls
	body, err := get(client, baseURL+"/api/Call/GetActiveCalls")
	if err != nil {
		return nil, fmt.Errorf("GetActiveCalls: %w", err)
	}

	var rawCalls []rawCall
	if err := json.Unmarshal(body, &rawCalls); err != nil {
		return nil, fmt.Errorf("unmarshal calls: %w (body: %.300s)", err, body)
	}

	var calls []dc911Call
	for _, rc := range rawCalls {
		// Field names vary across CadView instances — try common variants
		callID := coalesce(rc, "callID", "CallID", "call_id", "id", "ID")
		if callID == "" {
			continue
		}

		call := dc911Call{
			ID:         callID,
			Type:       strings.ToUpper(coalesce(rc, "callType", "CallType", "call_type", "type", "Nature", "nature")),
			Address:    coalesce(rc, "address", "Address", "location", "Location", "scene", "Scene"),
			AgencyType: normalizeAgencyType(coalesce(rc, "agencyType", "AgencyType", "agency_type", "AgencyID", "agencyID")),
		}

		// Fetch units for this call (non-fatal if it fails)
		units, err := fetchCallUnits(client, baseURL, callID)
		if err != nil {
			log.Printf("[dc911-proxy] GetCallUnits(%s): %v", callID, err)
		}
		call.Units = units
		calls = append(calls, call)
	}

	return calls, nil
}

// ---------------------------------------------------------------------------
// Fetch units for a single call
// ---------------------------------------------------------------------------

func fetchCallUnits(client *http.Client, baseURL, callID string) ([]dc911Unit, error) {
	endpoint := baseURL + "/api/Call/GetCallUnits?id=" + url.QueryEscape(callID)
	body, err := get(client, endpoint)
	if err != nil {
		return nil, fmt.Errorf("GetCallUnits: %w", err)
	}

	var rawUnits []rawUnit
	if err := json.Unmarshal(body, &rawUnits); err != nil {
		return nil, fmt.Errorf("unmarshal units: %w (body: %.300s)", err, body)
	}

	var units []dc911Unit
	for _, ru := range rawUnits {
		uid := coalesce(ru, "unitID", "UnitID", "unit_id", "unit", "Unit", "id", "ID")
		if uid == "" {
			continue
		}
		units = append(units, dc911Unit{
			ID:     uid,
			Status: coalesce(ru, "status", "Status", "unitStatus", "UnitStatus"),
		})
	}
	return units, nil
}

// ---------------------------------------------------------------------------
// POST normalized payload to HOSCAD
// ---------------------------------------------------------------------------

func ingest(hoscadURL, secret string, payload ingestPayload) error {
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	// HOSCAD API format: action=dc911Ingest&params=["secret",{...}]
	paramsJSON := fmt.Sprintf(`[%s,%s]`, jsonString(secret), payloadJSON)

	form := url.Values{}
	form.Set("action", "dc911Ingest")
	form.Set("params", paramsJSON)

	resp, err := http.Post(hoscadURL, "application/x-www-form-urlencoded",
		bytes.NewBufferString(form.Encode()))
	if err != nil {
		return fmt.Errorf("POST: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	log.Printf("[dc911-proxy] ingest HTTP %d: %s", resp.StatusCode, respBody)

	if resp.StatusCode != 200 {
		return fmt.Errorf("non-200 response: %d", resp.StatusCode)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func get(client *http.Client, endpoint string) ([]byte, error) {
	resp, err := client.Get(endpoint)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d from %s: %.200s", resp.StatusCode, endpoint, body)
	}
	return body, nil
}

// coalesce returns the first non-empty string value from a map for the given keys
func coalesce(m map[string]interface{}, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			s := fmt.Sprintf("%v", v)
			if s != "" && s != "<nil>" {
				return s
			}
		}
	}
	return ""
}

func normalizeAgencyType(raw string) string {
	t := strings.ToLower(strings.TrimSpace(raw))
	if strings.Contains(t, "fire") {
		return "Fire"
	}
	if strings.Contains(t, "law") || strings.Contains(t, "police") ||
		strings.Contains(t, "sheriff") || strings.Contains(t, "leo") {
		return "Law"
	}
	return "EMS"
}

// jsonString produces a JSON-quoted string (like %q but always valid JSON)
func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("[dc911-proxy] required env var %s not set", key)
	}
	return v
}
