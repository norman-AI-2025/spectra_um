/**
 * Spectra - Universiti Malaya SPeCTRUM Companion
 * Test Suite: iCalendar Feed (.ics) & Moodle AJAX (core_course_get_contents) Architecture
 *
 * Runs on standard JavaScriptCore (jsc) or Node.js.
 */

if (typeof console === "undefined") {
  globalThis.console = {
    log: typeof print !== "undefined" ? print : () => {},
    warn: typeof print !== "undefined" ? print : () => {},
    error: typeof print !== "undefined" ? print : () => {}
  };
}

import {
  parseIcsDateTime,
  parseMoodleIcsCalendar,
  parseCourseContentsModules,
  parseGradebookAttendance,
  isAttendanceActivity,
  isRespectiveOccurrence
} from "../utils/parser.js";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${message}`);
    failed++;
  }
}

console.log("=== Testing Spectra iCalendar & AJAX core_course_get_contents Engine ===");

// -------------------------------------------------------------
// Test 1: parseIcsDateTime
// -------------------------------------------------------------
console.log("\n--- Test 1: parseIcsDateTime ---");
const utcTs = parseIcsDateTime("20261028T155900Z");
assert(utcTs !== null, "Parses UTC format YYYYMMDDTHHMMSSZ");
const utcDate = new Date(utcTs);
assert(utcDate.getUTCFullYear() === 2026, "UTC Year matches 2026");
assert(utcDate.getUTCMonth() === 9, "UTC Month matches October (9)");
assert(utcDate.getUTCDate() === 28, "UTC Day matches 28");

const localTs = parseIcsDateTime("20261105T235900");
assert(localTs !== null, "Parses local format YYYYMMDDTHHMMSS");

const dateOnlyTs = parseIcsDateTime("20261201");
assert(dateOnlyTs !== null, "Parses date-only format YYYYMMDD");

// -------------------------------------------------------------
// Test 2: parseMoodleIcsCalendar
// -------------------------------------------------------------
console.log("\n--- Test 2: parseMoodleIcsCalendar RFC 5545 Parsing ---");

// Mock Moodle iCalendar export
const sampleIcs = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Moodle Pty Ltd//NONSGML Moodle 2026//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VEVENT
UID:1001@spectrum.um.edu.my
SUMMARY:WIX2002 Lab 1 Submission (Occ 1) is due
DESCRIPTION:Please submit your source code and report for Week 3 Lab.
CLASS:PUBLIC
LAST-MODIFIED:20261010T120000Z
DTSTAMP:20261021T080000Z
DTSTART:20261028T155900Z
DTEND:20261028T155900Z
CATEGORIES:WIX2002
URL:https://spectrum.um.edu.my/mod/assign/view.php?id=9901
END:VEVENT
BEGIN:VEVENT
UID:1002@spectrum.um.edu.my
SUMMARY:WIX2002 Lab 1 Submission (Occ 2) is due
CATEGORIES:WIX2002
DTSTART:20261029T155900Z
DTEND:20261029T155900Z
URL:https://spectrum.um.edu.my/mod/assign/view.php?id=9902
END:VEVENT
BEGIN:VEVENT
UID:1003@spectrum.um.edu.my
SUMMARY:Lecture Attendance Week 4 (Occ 1)
CATEGORIES:WIX2002
DTSTART:20261025T020000Z
DTEND:20261025T040000Z
URL:https://spectrum.um.edu.my/mod/attendance/view.php?id=9903
END:VEVENT
BEGIN:VEVENT
UID:1004@spectrum.um.edu.my
SUMMARY:WIA1001 Final Project Report (All Students) is due
CATEGORIES:WIA1001
DTSTART:20261115T155900Z
DTEND:20261115T155900Z
URL:https://spectrum.um.edu.my/mod/assign/view.php?id=9904
END:VEVENT
BEGIN:VEVENT
UID:1005@spectrum.um.edu.my
SUMMARY:Ancient 2020 Assignment is due
CATEGORIES:WIX2002
DTSTART:20201015T155900Z
DTEND:20201015T155900Z
URL:https://spectrum.um.edu.my/mod/assign/view.php?id=8805
END:VEVENT
END:VCALENDAR`;

const occ1Deadlines = parseMoodleIcsCalendar(sampleIcs, { WIX2002: "Occ 1" });
assert(Array.isArray(occ1Deadlines), "Returns array of deadlines");
assert(occ1Deadlines.length === 2, `Expected 2 deadlines for Occ 1 (got ${occ1Deadlines.length})`);

const labOcc1 = occ1Deadlines.find(d => d.id === "9901");
assert(labOcc1 !== undefined, "Captures WIX2002 Lab 1 (Occ 1)");
assert(labOcc1.title.includes("Lab 1 Submission (Occ 1)"), "Title cleaned (removes 'is due')");
assert(labOcc1.courseCode === "WIX2002", "Extracts course code from CATEGORIES");
assert(labOcc1.source === "ical", "Source tagged as ical");

const labOcc2 = occ1Deadlines.find(d => d.id === "9902");
assert(labOcc2 === undefined, "Strict: Occ 2 event is excluded when student is Occ 1");

const attEvt = occ1Deadlines.find(d => d.id === "9903");
assert(attEvt === undefined, "Strict: Attendance calendar event is excluded from assignment deadlines");

const projAll = occ1Deadlines.find(d => d.id === "9904");
assert(projAll !== undefined, "Universal assignment (All Students) is included");

const ancientEvt = occ1Deadlines.find(d => d.id === "8805");
assert(ancientEvt === undefined, "Strict: 100+ days overdue item is excluded");

// Test Occ 2 student
const occ2Deadlines = parseMoodleIcsCalendar(sampleIcs, { WIX2002: "Occ 2" });
const labOcc2Found = occ2Deadlines.find(d => d.id === "9902");
assert(labOcc2Found !== undefined, "Occ 2 student captures Occ 2 event");
const labOcc1Missing = occ2Deadlines.find(d => d.id === "9901");
assert(labOcc1Missing === undefined, "Occ 2 student does NOT capture Occ 1 event");

// -------------------------------------------------------------
// Test 3: parseCourseContentsModules (core_course_get_contents JSON)
// -------------------------------------------------------------
console.log("\n--- Test 3: parseCourseContentsModules (core_course_get_contents) ---");

const sampleSectionsJson = [
  {
    id: 1,
    name: "General",
    modules: [
      {
        id: 701,
        name: "Course Attendance",
        modname: "attendance",
        url: "https://spectrum.um.edu.my/mod/attendance/view.php?id=701"
      },
      {
        id: 702,
        name: "General Discussion Forum",
        modname: "forum",
        url: "https://spectrum.um.edu.my/mod/forum/view.php?id=702"
      }
    ]
  },
  {
    id: 2,
    name: "Week 4: Sorting Algorithms",
    modules: [
      {
        id: 703,
        name: "Assignment 1 (Occ 1)",
        modname: "assign",
        url: "https://spectrum.um.edu.my/mod/assign/view.php?id=703",
        dates: [
          { label: "Due:", timestamp: Math.floor(Date.now() / 1000) + 86400 }
        ],
        completiondata: { state: 0 }
      },
      {
        id: 704,
        name: "Assignment 1 (Occ 2)",
        modname: "assign",
        url: "https://spectrum.um.edu.my/mod/assign/view.php?id=704",
        dates: [
          { label: "Due:", timestamp: Math.floor(Date.now() / 1000) + 86400 }
        ],
        completiondata: { state: 0 }
      },
      {
        id: 705,
        name: "Lecture Attendance Week 4 (Occ 1)",
        modname: "attendance",
        url: "https://spectrum.um.edu.my/mod/attendance/view.php?id=705"
      }
    ]
  },
  {
    id: 3,
    name: "Week 14: Final Submission",
    modules: [
      {
        id: 706,
        name: "Final Project Turnitin Dropbox",
        modname: "turnitintooltwo",
        url: "https://spectrum.um.edu.my/mod/turnitintooltwo/view.php?id=706",
        dates: [
          { label: "Due:", timestamp: Math.floor(Date.now() / 1000) + 864000 }
        ],
        completiondata: { state: 1 }
      }
    ]
  }
];

const parsedContents = parseCourseContentsModules(sampleSectionsJson, "WIX2002", "Data Structures", "Occ 1");

assert(Array.isArray(parsedContents.assignments), "Returns assignments array");
assert(Array.isArray(parsedContents.attendanceModules), "Returns attendanceModules array");

// Attendance modules check
assert(parsedContents.attendanceModules.length === 2, `Discovered 2 attendance modules across sections (got ${parsedContents.attendanceModules.length})`);
assert(parsedContents.attendanceModules[0].cmid === "701", "Captured General Course Attendance (701)");
assert(parsedContents.attendanceModules[1].cmid === "705", "Captured Week 4 Attendance (705)");

// Assignments check for Occ 1
assert(parsedContents.assignments.length === 2, `Expected 2 assignments for Occ 1 (got ${parsedContents.assignments.length})`);
const assign1Occ1 = parsedContents.assignments.find(a => a.cmid === "703");
assert(assign1Occ1 !== undefined, "Captured Assignment 1 (Occ 1)");
assert(assign1Occ1.isSubmittedOnSpectrum === false, "Assignment 1 state 0 marked as incomplete");
assert(assign1Occ1.dueTimestamp !== null, "Extracted due timestamp from dates array");

const assign1Occ2 = parsedContents.assignments.find(a => a.cmid === "704");
assert(assign1Occ2 === undefined, "Strict: Assignment 1 (Occ 2) excluded for Occ 1 student");

const turnitinFinal = parsedContents.assignments.find(a => a.cmid === "706");
assert(turnitinFinal !== undefined, "Captured Turnitin dropbox from Week 14 bottom section");
assert(turnitinFinal.isSubmittedOnSpectrum === true, "Turnitin state 1 marked as submitted on SPeCTRUM");
assert(turnitinFinal.isCompleted === true, "Turnitin marked isCompleted: true");

// -------------------------------------------------------------
// Test 4: parseGradebookAttendance
// -------------------------------------------------------------
console.log("\n--- Test 4: parseGradebookAttendance ---");

const sampleGradebookHtml = `
<table class="generaltable user-grade">
  <thead><tr><th>Grade item</th><th>Weight</th><th>Grade</th><th>Range</th><th>Percentage</th></tr></thead>
  <tbody>
    <tr>
      <th class="item">Course Total</th>
      <td>100.0 %</td>
      <td class="grade">88.50</td>
      <td>0–100</td>
      <td>88.50 %</td>
    </tr>
    <tr>
      <th class="item"><a href="https://spectrum.um.edu.my/mod/attendance/view.php?id=701">Attendance</a></th>
      <td>10.0 %</td>
      <td class="grade">26.00</td>
      <td>0–28</td>
      <td>92.86 %</td>
    </tr>
    <tr>
      <th class="item">Assignment 1</th>
      <td>15.0 %</td>
      <td class="grade">14.00</td>
      <td>0–15</td>
      <td>93.33 %</td>
    </tr>
  </tbody>
</table>`;

const gradeAtt = parseGradebookAttendance(sampleGradebookHtml);
assert(gradeAtt !== null, "Successfully parsed gradebook attendance");
assert(gradeAtt.hasAttendance === true, "Flags hasAttendance: true");
assert(gradeAtt.percentage.includes("92.86"), `Parsed percentage 92.86% (got ${gradeAtt.percentage})`);

// -------------------------------------------------------------
// Summary
// -------------------------------------------------------------
console.log("\n=================================================================");
console.log(`  iCalendar & AJAX Engine Results: ${passed} passed, ${failed} failed`);
console.log("=================================================================");

if (failed > 0) {
  throw new Error(`${failed} tests failed.`);
}
