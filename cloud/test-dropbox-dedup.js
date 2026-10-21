import assert from "assert";
import { parseMoodleIcsCalendar } from "../utils/parser.js";
import {
  getTaskFingerprint,
  mergeDeadlineItems,
  deduplicateDeadlinesList,
  normalizeHydratedDeadlines
} from "../utils/calendar.js";

console.log("=== Testing Spectra Issue 1 (Dropbox Link) & Issue 2 (Deduplication) ===");

// -------------------------------------------------------------------
// TEST 1: Issue 1 - iCal Link Extraction & Fallback Protection
// -------------------------------------------------------------------
console.log("\n--- Test 1: iCal Dropbox Link & Fallback ---");

// Sub-test 1A: Direct course module link embedded in DESCRIPTION
const icsWithDescLink = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Moodle Pty Ltd//NONSGML Moodle 2026//EN
CALSCALE:GREGORIAN
BEGIN:VEVENT
UID:1140373@spectrum.um.edu.my
SUMMARY:WIX2002 Tutorial 1 Submission is due
DESCRIPTION:Please submit via the module activity: https://spectrum.um.edu.my/mod/assign/view.php?id=384102 before 5pm.
DTSTART:20261030T090000Z
DTEND:20261030T090000Z
CATEGORIES:WIX2002
URL:https://spectrum.um.edu.my/calendar/view.php?view=event&id=1140373
END:VEVENT
END:VCALENDAR`;

const parsedDesc = parseMoodleIcsCalendar(icsWithDescLink, { WIX2002: "Occ 1" });
assert(parsedDesc.length === 1, "Parses 1 event from iCal");
assert.strictEqual(parsedDesc[0].cmid, "384102", "Extracts real cmid from DESCRIPTION activity link");
assert.strictEqual(parsedDesc[0].url, "https://spectrum.um.edu.my/mod/assign/view.php?id=384102", "Uses direct module URL from DESCRIPTION");
console.log("✅ PASS: Direct module activity link in DESCRIPTION is prioritized");

// Sub-test 1B: Direct module link already present in URL
const icsWithDirectUrl = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:1140374@spectrum.um.edu.my
SUMMARY:WIX2002 Quiz 2 is due
DTSTART:20261030T090000Z
DTEND:20261030T090000Z
CATEGORIES:WIX2002
URL:https://spectrum.um.edu.my/mod/quiz/view.php?id=384199
END:VEVENT
END:VCALENDAR`;

const parsedUrl = parseMoodleIcsCalendar(icsWithDirectUrl, { WIX2002: "Occ 1" });
assert(parsedUrl.length === 1, "Parses 1 event from iCal");
assert.strictEqual(parsedUrl[0].cmid, "384199", "Extracts real cmid from URL");
assert.strictEqual(parsedUrl[0].url, "https://spectrum.um.edu.my/mod/quiz/view.php?id=384199", "Uses direct quiz URL");
console.log("✅ PASS: Direct module activity link in URL is used");

// Sub-test 1C: No direct module link found -> NEVER synthesize mod/assign/view.php?id=1140375
const icsWithCalendarUrlOnly = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:1140375@spectrum.um.edu.my
SUMMARY:WIX2002 Assignment 3 is due
DESCRIPTION:General assignment reminder without embedded direct link.
DTSTART:20261030T090000Z
DTEND:20261030T090000Z
CATEGORIES:WIX2002
URL:https://spectrum.um.edu.my/calendar/view.php?view=event&id=1140375
END:VEVENT
END:VCALENDAR`;

const parsedFallback = parseMoodleIcsCalendar(icsWithCalendarUrlOnly, { WIX2002: "Occ 1" });
assert(parsedFallback.length === 1, "Parses 1 event from iCal");
assert.strictEqual(parsedFallback[0].cmid, "", "Does NOT treat calendar event ID as cmid");
assert(
  !parsedFallback[0].url.includes("mod/assign/view.php?id=1140375"),
  "Never constructs synthetic invalid mod/assign/view.php URL using calendar event ID"
);
assert.strictEqual(
  parsedFallback[0].url,
  "https://spectrum.um.edu.my/calendar/view.php?view=event&id=1140375",
  "Falls back cleanly to legitimate calendar event URL"
);
console.log("✅ PASS: Fallback cleanly links to calendar/view.php without synthesizing broken mod/assign link");

// -------------------------------------------------------------------
// TEST 2: Issue 2 - Canonical Task Fingerprinting
// -------------------------------------------------------------------
console.log("\n--- Test 2: Task Fingerprinting ---");

const fpIcal = getTaskFingerprint("WIX2002", "Lab 1 Submission (Occ 1) is due");
const fpCourse = getTaskFingerprint("WIX2002", "Lab 1 Submission (Occ 1)");
const fpBare = getTaskFingerprint("wix-2002", "Lab 1 (Occ 1)");

assert.strictEqual(fpIcal, fpCourse, "Fingerprint matches between iCal 'is due' and course title");
assert.strictEqual(fpIcal, fpBare, "Fingerprint normalizes noise words like 'Lab', 'Submission'");
console.log(`✅ PASS: getTaskFingerprint matches correctly ('${fpIcal}')`);

// -------------------------------------------------------------------
// TEST 3: Issue 2 - Deduplication & Merging (iCal UID vs Course CMID)
// -------------------------------------------------------------------
console.log("\n--- Test 3: Deduplication & Merging ---");

const futureDueTs = Date.now() + 86400000;
const icalEntry = {
  id: "1140373",
  cmid: "",
  title: "Project Milestone 1 Submission (Occ 1) is due",
  courseCode: "WIX2002",
  courseName: "Project Management",
  dueTimestamp: futureDueTs,
  dueDate: new Date(futureDueTs).toISOString(),
  formattedTime: "Fri, 30 Oct, 04:00 PM",
  url: "https://spectrum.um.edu.my/calendar/view.php?view=event&id=1140373",
  source: "ical",
  submissionStatus: "No submission recorded",
  isSubmittedOnSpectrum: false,
  isCompleted: false
};

const courseEntry = {
  id: "384102",
  cmid: "384102",
  title: "Project Milestone 1 (Occ 1)",
  courseCode: "WIX2002",
  courseName: "Project Management",
  dueTimestamp: null,
  dueDate: "",
  formattedTime: "30 Oct 2026",
  url: "https://spectrum.um.edu.my/mod/assign/view.php?id=384102",
  source: "ajax",
  submissionStatus: "Submitted for grading",
  isSubmittedOnSpectrum: true,
  isCompleted: true
};

// Deduplicate list containing both entries
const dedupedList = deduplicateDeadlinesList([icalEntry, courseEntry]);

assert.strictEqual(dedupedList.length, 1, `Expected 1 deduplicated item, got ${dedupedList.length}`);
const merged = dedupedList[0];

assert.strictEqual(merged.id, "384102", "Preserves real course module ID (cmid)");
assert.strictEqual(merged.cmid, "384102", "Preserves real cmid");
assert.strictEqual(merged.url, "https://spectrum.um.edu.my/mod/assign/view.php?id=384102", "Preserves direct assignment URL from course scrape");
assert.strictEqual(merged.isSubmittedOnSpectrum, true, "Preserves verified submission status");
assert.strictEqual(merged.submissionStatus, "Submitted for grading", "Preserves course scrape submission status");
assert.strictEqual(merged.isCompleted, true, "Preserves completion state");
assert.strictEqual(merged.dueTimestamp, futureDueTs, "Retains high-precision timestamp from iCal event");
assert.strictEqual(merged.dueDate, new Date(futureDueTs).toISOString(), "Retains iCal ISO due date");

console.log("✅ PASS: Successfully deduplicated and merged iCal UID + course CMID entries");

// -------------------------------------------------------------------
// TEST 4: normalizeHydratedDeadlines with Mixed Duplicates
// -------------------------------------------------------------------
console.log("\n--- Test 4: normalizeHydratedDeadlines Deduplication ---");

const hydrated = normalizeHydratedDeadlines([icalEntry, courseEntry], [], {
  studentOccurrence: "Occ 1"
});

assert.strictEqual(hydrated.length, 1, `normalizeHydratedDeadlines returned exactly 1 item, got ${hydrated.length}`);
assert.strictEqual(hydrated[0].cmid, "384102", "Hydrated item retains cmid 384102");
assert.strictEqual(hydrated[0].isSubmittedOnSpectrum, true, "Hydrated item retains submitted status");
assert.strictEqual(hydrated[0].dueTimestamp, futureDueTs, "Hydrated item retains high precision timestamp");

console.log("✅ PASS: normalizeHydratedDeadlines safely deduplicates mixed cached lists");

console.log("\n=================================================================");
console.log("  All Issue 1 & Issue 2 Architectural Fixes Verified Successfully!");
console.log("=================================================================\n");
