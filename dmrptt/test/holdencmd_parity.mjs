// Parity test for dmrptt/holdencmd.js (hd2.6). Run from the repo root:  node dmrptt/test/holdencmd_parity.mjs
// 1. The CHAT-PARSER block in dmrptt/holdencmd.js must be byte-identical to the one in dmr/desktop/index.html
//    (line endings normalised), so the web app and the desktop parse every typed line the same way.
// 2. Both copies must give the same result on a table of lines (catches a block that is equal but wired differently).
// Offline only: no network, nothing sent.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const B = '/* ==== CHAT-PARSER-BEGIN ====', E = '/* ==== CHAT-PARSER-END ==== */';
function block(path) {
  const s = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const a = s.indexOf(B), b = s.indexOf(E);
  if (a < 0 || b < 0) throw new Error('markers missing in ' + path);
  return s.slice(a, b + E.length);
}
let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.log('FAIL', m); } };
const web = block('dmrptt/holdencmd.js'), desk = block('dmr/desktop/index.html');
ok(web === desk, 'CHAT-PARSER block in dmrptt/holdencmd.js differs from dmr/desktop/index.html: re-copy it');
// 1b. The family / radio-check layer (hd2.6): desktop "Pending server commands" through the end of updateChatHint
//     must equal what sits between FAMILY-BEGIN / FAMILY-END in holdencmd.js.
function famDesk(path) {
  const s = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const a = s.indexOf('/* Pending server commands (2026-10-17).');
  const u = s.indexOf('function updateChatHint()', a);
  if (a < 0 || u < 0) throw new Error('family block not found in ' + path);
  const end = s.indexOf('\n}\n', u) + 3;
  return s.slice(a, end);
}
function famWeb(path) {
  const s = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const B2 = '/* ==== FAMILY-BEGIN ==== */\n', E2 = '/* ==== FAMILY-END ==== */';
  const a = s.indexOf(B2), b = s.indexOf(E2);
  if (a < 0 || b < 0) throw new Error('FAMILY markers missing in ' + path);
  return s.slice(a + B2.length, b);
}
ok(famWeb('dmrptt/holdencmd.js') === famDesk('dmr/desktop/index.html'),
   'FAMILY block in dmrptt/holdencmd.js differs from dmr/desktop/index.html: re-copy it');

const deskParse = new Function(desk + '\nreturn parseChatLine;')();
const H = require('../holdencmd.js');
const roster = null;
const ctxs = [
  { canPage: true, listenOnly: false, pageTargets: [{ key: 'all', label: 'ALL' }, { key: 'kk7ion', label: 'KK7ION' }], myCall: 'KJ7DTS', curNet: 'holden', nets: ['holden', 'tgif'], roster },
  { canPage: false, listenOnly: true, pageTargets: [], myCall: 'N0CALL', curNet: 'holden', nets: ['holden'], roster },
];
const lines = ['help', '?', '/help', 'st', '.st', 'ping', 'ping kk7ion', 'ping dad', 'ping dad when you get home',
  'rc', 'rc kk7rbq', 'rc KK7ION', 'rc dad', 'rc car is fun', 'rc preston', 'radios', 'Radios are all charged', '.radios x',
  'rollcall', 'rollcall at 7 tonight?', 'lh', 'lh kk7ion', 'lh dad', '!lh', '!kk7ion', 'nr', 'sms', 'sms kk7ion hi there',
  'sms dad running late, door code 4512', '.sms 3195193 hi', 'pg/ test', 'pg/kk7ion come up', 'pg/bob hi', 'c', 'dc',
  'hello all', 'map', 'radar', 'aprs', 'track kk7ion', '', '   ', 'rc\tdad', 'rc dad', 'ping​dad', '\u{1F600}'];
for (const c of ctxs) for (const l of lines) {
  const a = JSON.stringify(deskParse(l, c)), b = JSON.stringify(H.parseChatLine(l, c));
  ok(a === b, 'result differs for ' + JSON.stringify(l) + ': desktop ' + a + ' web ' + b);
}
console.log(fail ? fail + ' FAILED' : 'holdencmd parity: OK (' + lines.length * ctxs.length + ' lines, blocks identical)');
process.exit(fail ? 1 : 0);
