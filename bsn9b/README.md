# Sumner BSN9B Nursing Documentation App

**Created by Christian Holden BSN9B**

A web-based nursing documentation tool designed for Sumner College nursing students to create professional progress notes and assessments.

**Live URL:** [holdenportal.com/bsn9b](https://holdenportal.com/bsn9b)

---

## Features

### Documentation Formats
- **DAR** - Data, Action, Response
- **DARP** - Data, Action, Response, Plan
- **SOAP** - Subjective, Objective, Assessment, Plan
- **SOAPIE** - SOAP + Intervention, Evaluation
- **SBAR** - Situation, Background, Assessment, Recommendation
- **PIE** - Problem, Intervention, Evaluation
- **Narrative** - Free-form narrative notes
- **Head-to-Toe (H2T)** - Comprehensive assessment with quick-fill buttons

### Quick Vitals Entry Panel
- Individual input fields for BP, HR, RR, Temp, O2%, Pain
- Expanded O2 delivery options:
  - Room Air (RA)
  - Nasal Cannula (1-6L)
  - Masks (Simple, Venturi, Non-Rebreather, Partial Rebreather)
  - Advanced (HFNC, CPAP, BiPAP, Trach Collar, T-Piece, Ventilator)
- One-click insert into any text field

### Smart Phrases
Type a shortcut followed by space to auto-expand text. Examples:
- `.vs` - Vital signs template
- `.neuro` - Neurological assessment
- `.resp` - Respiratory assessment
- `.cv` - Cardiovascular assessment
- `.gi` - GI assessment
- `.gu` - GU assessment
- `.skin` - Skin assessment
- `.pain` - Pain template
- `.aox4` - Alert and oriented x4
- `.perrla` - Pupil assessment
- `.mae` - Moving all extremities
- `.cta` - Clear to auscultation
- `.rrr` - Regular rate and rhythm
- `.wdta` - Will continue to monitor
- `.wnl` - Within normal limits
- `.nad` - No acute distress
- `.fall` - Fall precautions
- `.safe` - Safety measures
- `.edu` - Patient education
- `.dc` - Discharge instructions
- And more...

### NANDA Nursing Diagnoses Database
- Searchable database with 60+ nursing diagnoses
- Categories: Activity/Rest, Circulation, Ego Integrity, Elimination, Food/Fluid, Neurosensory, Pain/Discomfort, Respiration, Safety, Hygiene, Health Promotion
- Click to add diagnoses to documentation

### Head-to-Toe Assessment Quick-Fill Buttons
Pre-built phrases for rapid documentation:
- **Neuro:** A&Ox4, PERRLA, GCS 15, MAE x4
- **Cardio:** S1S2 RRR, Pulses 2+, Cap refill <3s, No edema
- **Resp:** CTA bilat, Unlabored, No SOB
- **GI:** BS active x4, Soft NT ND
- **GU:** Voiding, Foley patent
- **Skin:** WDI (Warm, Dry, Intact), No breakdown
- **MSK:** ROM intact, Gait steady
- **Pain:** Pain scales, Denies pain

### Export Options
- **PDF Export** - Professional formatted document with:
  - Header: "Sumner College - Bend Nursing Progress Note"
  - Patient/nurse info box
  - NANDA diagnoses section
  - Clean section formatting
  - Signature line
  - Educational disclaimer
- **Word Export** - .docx file with same formatting
- **File Naming:** `date_time_noteType_lastName.pdf/docx`

---

## User Access

### Login Credentials
| Username | Password | Role |
|----------|----------|------|
| sumner | nursingstudent | Student |
| np | nursingstudent | Student |
| instructor | sumnerinstructor | Instructor |
| holdenc | holdc123 | Owner |
| admin | admin1374 | Admin (full access + user management) |

### Admin Features (admin login only)
- **Manage Smart Phrases** - Add/delete custom shortcuts
- **Manage Users** - Add/delete custom user accounts
- Custom users and phrases stored in browser localStorage

---

## Technical Details

### Built With
- HTML5, CSS3, JavaScript (vanilla)
- **jsPDF** - PDF generation
- **docx.js** - Word document generation
- **FileSaver.js** - File download handling
- **FormSubmit.co** - Email form submissions

### File Structure
```
bsn9b/
├── index.html      # Login page
├── app.html        # Main application
└── README.md       # This documentation
```

### Hosting
- GitHub Pages via `ckholden/Holden-nerd-portal` repository
- Auto-deploys on push to main branch

### Data Storage
- **Session:** Login state (sessionStorage)
- **Persistent:** Custom users and smart phrases (localStorage)
- No server-side database - all client-side

---

## Development History

### Initial Build
1. Researched nursing documentation formats (DARP, SOAP, SBAR, PIE, etc.)
2. Created single-page web app with form-based documentation
3. Implemented PDF and Word export functionality
4. Added authentication system

### Feature Additions
1. **NANDA Database** - Added 60+ searchable nursing diagnoses
2. **Head-to-Toe Assessment** - New format with quick-fill buttons
3. **Smart Phrases** - Auto-expanding text shortcuts
4. **Quick Vitals Panel** - Structured input for vital signs
5. **Admin Panel** - User and phrase management
6. **Feedback System** - FormSubmit integration for suggestions

### UI/UX Improvements
1. Floating Smart Phrases reference button
2. Collapsible sections
3. Responsive grid layouts
4. Clean PDF export formatting (removed overlapping elements)
5. Professional header/footer with creator credit

### Security Features
1. Session-based authentication
2. Password hashing (basic obfuscation)
3. HIPAA warning for PHI/PII
4. Educational disclaimer on exports

---

## Future Enhancement Ideas
- I&O (Intake/Output) tracker
- Medication administration section
- Lab values reference panel
- Common abbreviations lookup
- Print-friendly mode
- Auto-save drafts to localStorage
- Additional smart phrases

---

## Feedback & Suggestions
Use the feedback form in the Smart Phrases modal (📝 button) to:
- Report issues
- Suggest new smart phrases
- Share general feedback

Submissions go directly to the app creator.

---

*Last Updated: January 2025*
