/**
 * Test Suite: Spectra Live Course Deadlines & Occurrence Filtering
 * Validates scanning of /mod/assign/index.php and /course/view.php (top to bottom)
 * with strict occurrence filtering and deduplication.
 */

if (typeof console === "undefined") {
  globalThis.console = {
    log: typeof print !== "undefined" ? print : () => {},
    warn: typeof print !== "undefined" ? print : () => {},
    error: typeof print !== "undefined" ? print : () => {}
  };
}

import {
  parseCourseAssignmentsIndex,
  parseCourseQuizzesIndex,
  parseCourseViewSubmissions,
  parseCalendarEvents,
  isAttendanceActivity,
  isOverdueMoreThan40Days,
  isOverdueMoreThan100Days,
  isRespectiveOccurrence,
  calculateUrgency,
  formatTimeRemaining,
  formatDueCalendarDate,
  parseAssignmentViewPage,
  parseMoodleDateString,
  cleanMoodleTitle
} from "../utils/parser.js";
import { fetchLiveDeadlines, normalizeHydratedDeadlines } from "../utils/calendar.js";

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

console.log("=== Testing Spectra Course Submission Pages & Occurrence Filtering ===");

// -------------------------------------------------------------
// Test 0: Attendance Activity Differentiation vs Submissions
// -------------------------------------------------------------
console.log("\n--- Sub-test 0: Attendance Differentiation & 40-Day Overdue Filter ---");
assert(isAttendanceActivity({ modulename: "attendance" }), "Identifies modulename attendance");
assert(isAttendanceActivity({ eventtype: "attendance" }), "Identifies eventtype attendance");
assert(isAttendanceActivity({ url: "https://spectrum.um.edu.my/mod/attendance/view.php?id=9901" }), "Identifies attendance URL");
assert(isAttendanceActivity({ title: "Attendance" }), "Identifies pure Attendance title");
assert(isAttendanceActivity({ title: "Attendance Week 2" }), "Identifies Attendance Week 2");
assert(isAttendanceActivity({ title: "Lecture Attendance (Occ 1)" }), "Identifies attendance title");
assert(isAttendanceActivity({ title: "Rekod Kehadiran Tutorial" }), "Identifies BM Kehadiran title");
assert(isAttendanceActivity({ title: "Take Attendance - Group 2" }), "Identifies Take Attendance title");
assert(isAttendanceActivity({ title: "Attendence (Occ 1)" }), "Identifies typo Attendence");
assert(isAttendanceActivity({ title: "Check-in Week 3" }), "Identifies Check-in Week 3");
assert(isAttendanceActivity({ title: "Weekly Class Sign-in" }), "Identifies Class Sign-in");
assert(isAttendanceActivity({ title: "Borang Kehadiran Kuliah" }), "Identifies Borang Kehadiran Kuliah");
assert(isAttendanceActivity({ title: "Kehadiran Minggu 4 (Occ 2)" }), "Identifies Kehadiran Minggu 4");

// Coursework assignments must NEVER be flagged as attendance
assert(!isAttendanceActivity({ title: "Assignment 1 (Occ 1)", url: "https://spectrum.um.edu.my/mod/assign/view.php?id=101", type: "assign" }), "Assignment 1 is not attendance");
assert(!isAttendanceActivity({ title: "Quiz 2: Data Structures", url: "https://spectrum.um.edu.my/mod/quiz/view.php?id=202", type: "quiz" }), "Quiz 2 is not attendance");
assert(!isAttendanceActivity({ title: "Turnitin Essay Submission", url: "https://spectrum.um.edu.my/mod/turnitintooltwo/view.php?id=303", type: "turnitin" }), "Turnitin is not attendance");
assert(!isAttendanceActivity({ title: "Lab 3 Report", url: "https://spectrum.um.edu.my/mod/assign/view.php?id=404", type: "assign" }), "Lab Report is not attendance");

// Academic projects ABOUT an attendance system must remain classified as assignments
assert(!isAttendanceActivity({ title: "Assignment 2: Smart Attendance System", url: "https://spectrum.um.edu.my/mod/assign/view.php?id=505", type: "assign" }), "Project about attendance system is not attendance check-in");
assert(!isAttendanceActivity({ title: "Final Project: RFID Attendance Tracker App", url: "https://spectrum.um.edu.my/mod/assign/view.php?id=506", type: "assign" }), "Project about attendance app is not attendance check-in");

// Test isOverdueMoreThan40Days
const now = Date.now();
const dayMs = 24 * 60 * 60 * 1000;
assert(isOverdueMoreThan40Days(now - 45 * dayMs, now), "Item due 45 days ago is identified as overdue > 40 days");
assert(isOverdueMoreThan40Days(now - 180 * dayMs, now), "Item due 180 days ago is identified as overdue > 40 days");
assert(!isOverdueMoreThan40Days(now - 39 * dayMs, now), "Item due 39 days ago is NOT overdue > 40 days");
assert(!isOverdueMoreThan40Days(now - 10 * dayMs, now), "Item due 10 days ago is NOT overdue > 40 days");
assert(!isOverdueMoreThan40Days(now + 2 * dayMs, now), "Future item is NOT overdue > 40 days");
assert(!isOverdueMoreThan40Days(null, now), "Null due date is NOT overdue > 40 days");

// parseCalendarEvents strictly filters out attendance and items overdue > 40 days
const mixedCalendarAjax = {
  events: [
    { id: 101, name: "Assignment 1", modulename: "assign", timesort: Math.floor(Date.now() / 1000) + 3600 },
    { id: 102, name: "Lecture Attendance Occ 1", modulename: "attendance", timesort: Math.floor(Date.now() / 1000) + 1800, url: "https://spectrum.um.edu.my/mod/attendance/view.php?id=50" },
    { id: 103, name: "Quiz 1", modulename: "quiz", timesort: Math.floor(Date.now() / 1000) + 7200 },
    { id: 104, name: "Ancient Assignment 0", modulename: "assign", timesort: Math.floor((Date.now() - 50 * dayMs) / 1000) }
  ]
};
const parsedCalendarEvents = parseCalendarEvents(mixedCalendarAjax);
assert(parsedCalendarEvents.length === 2, `parseCalendarEvents filtered attendance & 40d overdue (expected 2, got ${parsedCalendarEvents.length})`);
assert(!parsedCalendarEvents.some(e => e.title.includes("Attendance")), "Attendance event excluded from parsed calendar");
assert(!parsedCalendarEvents.some(e => e.id === "104"), "50-day overdue assignment excluded from parsed calendar");
assert(parsedCalendarEvents.some(e => e.title === "Assignment 1"), "Assignment 1 retained");
assert(parsedCalendarEvents.some(e => e.title === "Quiz 1"), "Quiz 1 retained");

// -------------------------------------------------------------
// Test 1: isRespectiveOccurrence with compound titles and variations
// -------------------------------------------------------------
console.log("\n--- Sub-test 1: isRespectiveOccurrence ---");
assert(isRespectiveOccurrence("", "Occ 1", "Assignment 1 (Occ 1)"), "Assignment 1 (Occ 1) matches student Occ 1");
assert(!isRespectiveOccurrence("", "Occ 1", "Assignment 1 (Occ 2)"), "Assignment 1 (Occ 2) strictly rejected for student Occ 1");
assert(!isRespectiveOccurrence("", "Occ 2", "Assignment 2 (Occ 1)"), "Assignment 2 (Occ 1) strictly rejected for student Occ 2");
assert(isRespectiveOccurrence("", "Occ 2", "Assignment 2 (Occ 2)"), "Assignment 2 (Occ 2) matches student Occ 2");
assert(isRespectiveOccurrence("", "Occ 1", "Final Project (Universal Submission)"), "Universal assignment matches student Occ 1");
assert(isRespectiveOccurrence("", "Occ 1", "General Assignment 3"), "General assignment with number matches student Occ 1");
assert(!isRespectiveOccurrence("", "Occ 1", "Lab Report - Kumpulan 2"), "Kumpulan 2 rejected for student Occ 1");
assert(isRespectiveOccurrence("", "Occ 1", "Lab Report - Kumpulan 1"), "Kumpulan 1 matches student Occ 1");

// Various user-entered occurrence formats
assert(isRespectiveOccurrence("", "1", "Assignment 1 (Occ 1)"), "User entering '1' matches Occ 1");
assert(isRespectiveOccurrence("", "Occurrence 2", "Lab 2 (Occ 2)"), "User entering 'Occurrence 2' matches Occ 2");
assert(isRespectiveOccurrence("", "Group 1", "Assignment 1 (Group 1)"), "User entering 'Group 1' matches Group 1");
assert(isRespectiveOccurrence("", "Tut 2", "Tutorial 2 (Tut 2)"), "User entering 'Tut 2' matches Tut 2");
assert(isRespectiveOccurrence("", "Tutorial 3", "Lab Task (Tutorial 3)"), "User entering 'Tutorial 3' matches Tutorial 3");
assert(isRespectiveOccurrence("", "Occ 01", "Assignment 1 (Occ 1)"), "User entering 'Occ 01' matches Occ 1 (zero-padded)");

// -------------------------------------------------------------
// Test 2: parseCourseAssignmentsIndex (/mod/assign/index.php)
// -------------------------------------------------------------
console.log("\n--- Sub-test 2: parseCourseAssignmentsIndex ---");
const mockAssignIndexHtml = `
<table class="generaltable mod_index">
  <thead>
    <tr>
      <th>Topic</th>
      <th>Name</th>
      <th>Due date</th>
      <th>Submission</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Week 1</td>
      <td><a href="https://spectrum.um.edu.my/mod/assign/view.php?id=1001">Assignment 1 (Occ 1)</a></td>
      <td>Friday, 24 October 2026, 11:59 PM</td>
      <td>Submitted for grading</td>
    </tr>
    <tr>
      <td>Week 1</td>
      <td><a href="https://spectrum.um.edu.my/mod/assign/view.php?id=1002">Assignment 1 (Occ 2)</a></td>
      <td>Friday, 24 October 2026, 11:59 PM</td>
      <td>No submission</td>
    </tr>
    <tr>
      <td>Week 5</td>
      <td><a href="https://spectrum.um.edu.my/mod/assign/view.php?id=1003">Midterm Project (All Students)</a></td>
      <td>Monday, 10 November 2026, 5:00 PM</td>
      <td>No submission</td>
    </tr>
    <tr>
      <td>Week 14</td>
      <td><a href="https://spectrum.um.edu.my/mod/assign/view.php?id=1004">Final Dropbox (Occ 2)</a></td>
      <td>Sunday, 20 December 2026, 11:59 PM</td>
      <td>No submission</td>
    </tr>
    <tr>
      <td>Week 14</td>
      <td><a href="https://spectrum.um.edu.my/mod/assign/view.php?id=1005">Final Dropbox (Occ 1)</a></td>
      <td>Sunday, 20 December 2026, 11:59 PM</td>
      <td>No submission</td>
    </tr>
    <tr>
      <td>Week 1</td>
      <td><a href="https://spectrum.um.edu.my/mod/assign/view.php?id=1006">Attendance Week 1 (Occ 1)</a></td>
      <td>Friday, 24 October 2026, 11:59 PM</td>
      <td>Submitted for grading</td>
    </tr>
    <tr>
      <td>Early Term</td>
      <td><a href="https://spectrum.um.edu.my/mod/assign/view.php?id=1007">Ancient Survey (Occ 1)</a></td>
      <td>Wednesday, 1 January 2025, 11:59 PM</td>
      <td>No submission</td>
    </tr>
  </tbody>
</table>
`;

const occ1Assignments = parseCourseAssignmentsIndex(mockAssignIndexHtml, "WIF3001", "Software Engineering", "Occ 1");
assert(occ1Assignments.length === 3, `Occ 1 gets exactly 3 assignments (got ${occ1Assignments.length})`);
assert(occ1Assignments.some(a => a.cmid === "1001" && a.isSubmittedOnSpectrum === true), "Assignment 1 (Occ 1) is included and marked Submitted");
assert(occ1Assignments.some(a => a.cmid === "1003"), "Universal Midterm Project is included");
assert(occ1Assignments.some(a => a.cmid === "1005"), "Bottom Week 14 Final Dropbox (Occ 1) is included");
assert(!occ1Assignments.some(a => a.cmid === "1002"), "Assignment 1 (Occ 2) is strictly excluded");
assert(!occ1Assignments.some(a => a.cmid === "1004"), "Final Dropbox (Occ 2) is strictly excluded");
assert(!occ1Assignments.some(a => a.cmid === "1006"), "Attendance in assign index strictly excluded from submissions");
assert(!occ1Assignments.some(a => a.cmid === "1007"), "Ancient 40+ days overdue assignment strictly excluded");

const occ2Assignments = parseCourseAssignmentsIndex(mockAssignIndexHtml, "WIF3001", "Software Engineering", "Occ 2");
assert(occ2Assignments.length === 3, `Occ 2 gets exactly 3 assignments (got ${occ2Assignments.length})`);
assert(occ2Assignments.some(a => a.cmid === "1002"), "Assignment 1 (Occ 2) is included for Occ 2");
assert(occ2Assignments.some(a => a.cmid === "1004"), "Final Dropbox (Occ 2) is included for Occ 2");
assert(!occ2Assignments.some(a => a.cmid === "1001"), "Assignment 1 (Occ 1) is strictly excluded for Occ 2");

// -------------------------------------------------------------
// Test 3: parseCourseViewSubmissions (/course/view.php)
// -------------------------------------------------------------
console.log("\n--- Sub-test 3: parseCourseViewSubmissions (Top to bottom) ---");
const mockCourseViewHtml = `
<ul class="topics">
  <!-- Top Section (Week 1) -->
  <li class="section main" id="section-1">
    <h3 class="sectionname">Week 1: Introduction</h3>
    <ul class="section img-text">
      <li class="activity assign modtype_assign" id="module-2001">
        <div class="activity-instance">
          <a href="https://spectrum.um.edu.my/mod/assign/view.php?id=2001">
            <span class="instancename">Diagnostic Quiz / Assignment (Occ 1)</span>
          </a>
        </div>
        <div class="activity-dates">Due: Friday, 24 October 2026, 11:59 PM</div>
        <div class="activity-information"><span class="badge">Done</span></div>
      </li>
      <li class="activity assign modtype_assign" id="module-2002">
        <div class="activity-instance">
          <a href="https://spectrum.um.edu.my/mod/assign/view.php?id=2002">
            <span class="instancename">Diagnostic Quiz / Assignment (Occ 2)</span>
          </a>
        </div>
        <div class="activity-dates">Due: Friday, 24 October 2026, 11:59 PM</div>
      </li>
    </ul>
  </li>

  <!-- Middle Section (Week 7) -->
  <li class="section main" id="section-7">
    <h3 class="sectionname">Week 7: Midterm Quiz</h3>
    <ul class="section img-text">
      <li class="activity quiz modtype_quiz" id="module-2003">
        <div class="activity-instance">
          <a href="https://spectrum.um.edu.my/mod/quiz/view.php?id=2003">
            <span class="instancename">Midterm Online Quiz (All Students)</span>
          </a>
        </div>
        <div class="activity-dates">Closes: Saturday, 15 November 2026, 10:00 PM</div>
      </li>
    </ul>
  </li>

  <!-- Bottom Section (Week 14) -->
  <li class="section main" id="section-14">
    <h3 class="sectionname">Week 14: Project Submission</h3>
    <ul class="section img-text">
      <li class="activity turnitintooltwo modtype_turnitintooltwo" id="module-2004">
        <div class="activity-instance">
          <a href="https://spectrum.um.edu.my/mod/turnitintooltwo/view.php?id=2004">
            <span class="instancename">Final Capstone Report Turnitin (Occ 2)</span>
          </a>
        </div>
        <div class="activity-dates">Due: Thursday, 24 December 2026, 11:59 PM</div>
      </li>
      <li class="activity turnitintooltwo modtype_turnitintooltwo" id="module-2005">
        <div class="activity-instance">
          <a href="https://spectrum.um.edu.my/mod/turnitintooltwo/view.php?id=2005">
            <span class="instancename">Final Capstone Report Turnitin (Occ 1)</span>
          </a>
        </div>
        <div class="activity-dates">Due: Thursday, 24 December 2026, 11:59 PM</div>
      </li>
      <li class="activity assign modtype_assign" id="module-2006">
        <div class="activity-instance">
          <a href="https://spectrum.um.edu.my/mod/assign/view.php?id=2006">
            <span class="instancename">Attendance Week 1 - Lecture Session (Occ 1)</span>
          </a>
        </div>
        <div class="activity-dates">Due: Friday, 24 October 2026, 11:59 PM</div>
      </li>
      <li class="activity assign modtype_assign" id="module-2007">
        <div class="activity-instance">
          <a href="https://spectrum.um.edu.my/mod/assign/view.php?id=2007">
            <span class="instancename">Ancient Diagnostic Test (Occ 1)</span>
          </a>
        </div>
        <div class="activity-dates">Due: Wednesday, 1 January 2025, 11:59 PM</div>
      </li>
    </ul>
  </li>
</ul>
`;

const courseSubmissionsOcc1 = parseCourseViewSubmissions(mockCourseViewHtml, "WIF3002", "Data Science", "Occ 1");
assert(courseSubmissionsOcc1.length === 3, `Discovers 3 submissions for Occ 1 from top to bottom (got ${courseSubmissionsOcc1.length})`);
assert(courseSubmissionsOcc1.some(s => s.cmid === "2001" && s.type === "assign"), "Top section Week 1 Occ 1 assignment captured");
assert(courseSubmissionsOcc1.some(s => s.cmid === "2003" && s.type === "quiz"), "Middle section Week 7 Quiz captured");
assert(courseSubmissionsOcc1.some(s => s.cmid === "2005" && s.type === "turnitin"), "Bottom section Week 14 Turnitin Occ 1 captured");
assert(!courseSubmissionsOcc1.some(s => s.cmid === "2002"), "Top section Occ 2 assignment excluded");
assert(!courseSubmissionsOcc1.some(s => s.cmid === "2004"), "Bottom section Occ 2 Turnitin excluded");
assert(!courseSubmissionsOcc1.some(s => s.cmid === "2006"), "Attendance in course view strictly excluded");
assert(!courseSubmissionsOcc1.some(s => s.cmid === "2007"), "Ancient 40+ days overdue submission in course view strictly excluded");

// -------------------------------------------------------------
// Test 4: End-to-End fetchLiveDeadlines with Mocked Fetches
// -------------------------------------------------------------
console.log("\n--- Sub-test 4: fetchLiveDeadlines Pipeline ---");

// Mock global fetch
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const urlStr = String(url);

  // Moodle AJAX calendar
  if (urlStr.includes("core_calendar_get_action_events_by_timesort")) {
    return {
      ok: true,
      status: 200,
      json: async () => [
        {
          data: {
            events: [
              {
                id: 9001,
                instance: 1001,
                name: "Assignment 1 (Occ 1) is due",
                timesort: Math.floor(Date.now() / 1000) + 3600 * 12, // 12h away (< 24h: urgent)
                course: { id: 10, shortname: "WIF3001", fullname: "Software Engineering" },
                url: "https://spectrum.um.edu.my/mod/assign/view.php?id=1001",
                action: { actionable: false } // already submitted
              },
              {
                id: 9002,
                instance: 1002,
                name: "Assignment 1 (Occ 2) is due",
                timesort: Math.floor(Date.now() / 1000) + 3600 * 12,
                course: { id: 10, shortname: "WIF3001", fullname: "Software Engineering" },
                url: "https://spectrum.um.edu.my/mod/assign/view.php?id=1002",
                action: { actionable: true }
              },
              {
                id: 9005,
                instance: 5001,
                name: "Lecture Attendance (Occ 1) is due",
                modulename: "attendance",
                eventtype: "attendance",
                timesort: Math.floor(Date.now() / 1000) + 3600 * 4,
                course: { id: 10, shortname: "WIF3001", fullname: "Software Engineering" },
                url: "https://spectrum.um.edu.my/mod/attendance/view.php?id=5001",
                action: { actionable: true }
              },
              {
                id: 9006,
                instance: 5002,
                name: "Ancient Semester Task is due",
                modulename: "assign",
                timesort: Math.floor((Date.now() - 150 * 24 * 60 * 60 * 1000) / 1000),
                course: { id: 10, shortname: "WIF3001", fullname: "Software Engineering" },
                url: "https://spectrum.um.edu.my/mod/assign/view.php?id=5002",
                action: { actionable: true }
              }
            ]
          }
        }
      ]
    };
  }

  // Assign index
  if (urlStr.includes("/mod/assign/index.php")) {
    return {
      ok: true,
      status: 200,
      text: async () => mockAssignIndexHtml
    };
  }

  // Course view
  if (urlStr.includes("/course/view.php")) {
    return {
      ok: true,
      status: 200,
      text: async () => mockCourseViewHtml
    };
  }

  return { ok: false, status: 404, text: async () => "" };
};

const mockCourses = [
  { id: "10", code: "WIF3001", name: "Software Engineering" }
];
const mockOccurrences = {
  "10": "Occ 1"
};

const deadlines = await fetchLiveDeadlines("test_sesskey", mockCourses, mockOccurrences);

assert(Array.isArray(deadlines), "fetchLiveDeadlines returns an array");
assert(deadlines.length > 0, `Returns merged deadlines list (count: ${deadlines.length})`);

// Check that Occ 2 items were strictly excluded
const hasOcc2 = deadlines.some(d => d.title.includes("Occ 2"));
assert(!hasOcc2, "Strict: No Occ 2 activities in the resulting deadlines list");

// Check that Attendance items are strictly excluded
const hasAttendance = deadlines.some(d => d.type === "attendance" || d.id === "9005" || d.cmid === "5001" || /attendance|kehadiran/i.test(d.title) || (d.url && d.url.includes("/mod/attendance/")));
assert(!hasAttendance, "Strict: Attendance events are never included in fetchLiveDeadlines");

// Check that 40+ days overdue items are strictly excluded
const hasOverdueOver40Days = deadlines.some(d => d.id === "9006" || d.cmid === "5002" || (d.dueTimestamp && isOverdueMoreThan40Days(d.dueTimestamp)));
assert(!hasOverdueOver40Days, "Strict: Items overdue > 40 days are strictly excluded from fetchLiveDeadlines");

// Check deduplication
const item1001List = deadlines.filter(d => d.cmid === "1001" || d.id === "1001" || d.id === "9001");
assert(item1001List.length === 1, "Assignment 1 (Occ 1) is deduplicated into a single entry");

// Check completion status
const item1001 = item1001List[0];
assert(item1001 && item1001.isCompleted === true, "Item 1001 is correctly marked isCompleted: true");
assert(item1001 && item1001.isSubmittedOnSpectrum === true, "Item 1001 is marked isSubmittedOnSpectrum: true");

// Check bottom dropbox included
const bottomItem = deadlines.find(d => d.cmid === "1005" || d.title.includes("Final Dropbox (Occ 1)"));
assert(Boolean(bottomItem), "Bottom Week 14 dropbox Final Dropbox (Occ 1) is present in deadlines");

// Restore fetch
globalThis.fetch = originalFetch;

// -------------------------------------------------------------
// Test 5: normalizeHydratedDeadlines (Cache Precedence, Occurrence Filtering & Submission Persistence)
// -------------------------------------------------------------
console.log("\n--- Sub-test 5: normalizeHydratedDeadlines Cache Hydration ---");

const mockCachedDeadlines = [
  {
    id: "9001",
    cmid: "1001",
    title: "Assignment 1 (Occ 1)",
    courseCode: "WIF3001",
    dueTimestamp: Date.now() + 86400000,
    isSubmittedOnSpectrum: true,
    submissionStatus: "Submitted for grading",
    isCompleted: true
  },
  {
    id: "9002",
    cmid: "1002",
    title: "Assignment 1 (Occ 2)", // Belongs to other occurrence!
    courseCode: "WIF3001",
    dueTimestamp: Date.now() + 86400000,
    isSubmittedOnSpectrum: false,
    isCompleted: false
  },
  {
    id: "9003",
    cmid: "1003",
    title: "Project Alpha (Universal)",
    courseCode: "WIF3001",
    dueTimestamp: Date.now() + 172800000,
    isSubmittedOnSpectrum: false,
    submissionStatus: "No submission",
    isCompleted: false
  }
];

const mockRawEvents = [
  {
    id: 9001,
    instance: 1001,
    name: "Assignment 1 (Occ 1) is due",
    timesort: Math.floor(Date.now() / 1000) + 86400,
    course: { shortname: "WIF3001" },
    action: { actionable: true } // In Moodle action events, actionable is often true even if submitted
  },
  {
    id: 9002,
    instance: 1002,
    name: "Assignment 1 (Occ 2) is due", // Occ 2!
    timesort: Math.floor(Date.now() / 1000) + 86400,
    course: { shortname: "WIF3001" },
    action: { actionable: true }
  },
  {
    id: 9005,
    instance: 5001,
    name: "Lecture Attendance (Occ 1)",
    modulename: "attendance",
    timesort: Math.floor(Date.now() / 1000) + 3600,
    course: { shortname: "WIF3001" }
  }
];

// Test 5A: When cached_deadlines exist, they must take precedence over raw calendar events
const hydratedFromCache = normalizeHydratedDeadlines(mockCachedDeadlines, mockRawEvents, {
  courseOccurrences: { "WIF3001": "Occ 1" },
  studentOccurrence: "Occ 1"
});

assert(hydratedFromCache.length === 2, `Hydrated exactly 2 matching tasks from cache (got ${hydratedFromCache.length})`);
const cacheOcc2 = hydratedFromCache.find(d => d.title.includes("Occ 2"));
assert(!cacheOcc2, "Strict: Occ 2 task is never shown on cache hydration");
const cacheSubmitted = hydratedFromCache.find(d => d.cmid === "1001");
assert(cacheSubmitted && cacheSubmitted.isSubmittedOnSpectrum === true, "Task 1001 retains isSubmittedOnSpectrum: true on popup open");
assert(cacheSubmitted && cacheSubmitted.isCompleted === true, "Task 1001 retains isCompleted: true on popup open");

// Test 5B: When cached_deadlines is explicitly empty [], it must return [] without falling back to raw events
const hydratedEmpty = normalizeHydratedDeadlines([], mockRawEvents, {
  courseOccurrences: { "WIF3001": "Occ 1" },
  studentOccurrence: "Occ 1"
});
assert(hydratedEmpty.length === 0, "Explicitly empty cached_deadlines returns empty without resurrecting raw events");

// Test 5C: When falling back to rawCalendarEvents (e.g. initial login before live scrape)
const hydratedFromRaw = normalizeHydratedDeadlines(null, mockRawEvents, {
  courseOccurrences: { "WIF3001": "Occ 1" },
  studentOccurrence: "Occ 1",
  completedIds: new Set(["9003"])
});
assert(hydratedFromRaw.length === 1, `Raw fallback captures only Occ 1 non-attendance events (got ${hydratedFromRaw.length})`);
assert(hydratedFromRaw[0].cmid === "1001", "Raw fallback matches Assignment 1 (Occ 1)");
assert(!hydratedFromRaw.some(d => d.title.includes("Occ 2")), "Strict: Raw fallback excludes Occ 2");
assert(!hydratedFromRaw.some(d => d.type === "attendance"), "Strict: Raw fallback excludes attendance");

// Test 5D: Malay submission status keywords in parser
const mockMalayAssignHtml = `
<table>
  <tr>
    <td><a href="https://spectrum.um.edu.my/mod/assign/view.php?id=3001">Tugasan 1 (Occ 1)</a></td>
    <td>Friday, 30 October 2026, 11:59 PM</td>
    <td>Telah dinilai</td>
  </tr>
  <tr>
    <td><a href="https://spectrum.um.edu.my/mod/assign/view.php?id=3002">Tugasan 2 (Occ 1)</a></td>
    <td>Friday, 30 October 2026, 11:59 PM</td>
    <td>Dihantar untuk dinilai</td>
  </tr>
  <tr>
    <td><a href="https://spectrum.um.edu.my/mod/assign/view.php?id=3003">Tugasan 3 (Occ 1)</a></td>
    <td>Friday, 30 October 2026, 11:59 PM</td>
    <td>Tiada penghantaran</td>
  </tr>
</table>
`;
const malayTasks = parseCourseAssignmentsIndex(mockMalayAssignHtml, "WIX1002", "Data Science", "Occ 1");
assert(malayTasks.length === 3, `Parsed 3 Malay assignments (got ${malayTasks.length})`);
const task3001 = malayTasks.find(t => t.cmid === "3001");
assert(task3001 && task3001.isSubmittedOnSpectrum === true, "'Telah dinilai' marked isSubmittedOnSpectrum: true");
const task3002 = malayTasks.find(t => t.cmid === "3002");
assert(task3002 && task3002.isSubmittedOnSpectrum === true, "'Dihantar untuk dinilai' marked isSubmittedOnSpectrum: true");
const task3003 = malayTasks.find(t => t.cmid === "3003");
assert(task3003 && task3003.isSubmittedOnSpectrum === false, "'Tiada penghantaran' marked isSubmittedOnSpectrum: false");

// Test 5E: Strictly reject dummy/corrupted objects and eliminate synthetic fake assignments
console.log("\n--- Sub-test 5E: Synthetic Dummy Assignment Elimination ---");
const corruptCandidateList = [
  {}, // completely empty object
  { courseCode: "UM" }, // object without title or task
  { id: "scraped-0-Assignment", title: "Assignment", courseCode: "UM", url: "https://spectrum.um.edu.my/my/" }, // synthetic ghost from old bug
  { "Course Code": "GIG1013" }, // legacy table item without Assignment / Task
  {
    id: "777",
    cmid: "777",
    title: "Real Lab Report",
    courseCode: "WIX2001",
    // No due date specified
    url: "https://spectrum.um.edu.my/mod/assign/view.php?id=777"
  },
  {
    id: "888",
    cmid: "888",
    title: "Assignment", // Real lecturer named it "Assignment"
    courseCode: "WIX2002",
    dueTimestamp: Date.now() + 86400000,
    url: "https://spectrum.um.edu.my/mod/assign/view.php?id=888"
  }
];

const sanitizedHydration = normalizeHydratedDeadlines(corruptCandidateList, [], {
  studentOccurrence: "Occ 1"
});

assert(sanitizedHydration.length === 2, `Expected exactly 2 valid items, got ${sanitizedHydration.length}`);
const labReport = sanitizedHydration.find(d => d.id === "777");
assert(Boolean(labReport), "Real Lab Report is preserved");
assert(labReport.dueTimestamp === null, "Missing due date does NOT synthesize 24h urgency");
assert(labReport.formattedTime === "No due date", "Formatted time reflects no due date");

const realAssignment = sanitizedHydration.find(d => d.id === "888");
assert(Boolean(realAssignment), "Legitimate assignment titled 'Assignment' with real Moodle URL is NOT dropped");
assert(realAssignment.courseCode === "WIX2002", "Preserves genuine course code WIX2002");

assert(!sanitizedHydration.some(d => d.id === "scraped-0-Assignment"), "Synthetic ghost 'scraped-0-Assignment' is eliminated");
assert(!sanitizedHydration.some(d => d.courseCode === "UM" && d.url.includes("/my/")), "Fake 'UM' ghost pointing to /my/ is eliminated");

// Test 5F: parseAssignmentViewPage & formatDueCalendarDate
console.log("\n--- Sub-test 5F: Direct Assignment Page & Date Formatting ---");
const mockAssignViewHtml = `
<table class="generaltable">
  <tr>
    <th class="c0">Submission status</th>
    <td class="c1">Submitted for grading</td>
  </tr>
  <tr>
    <th class="c0">Grading status</th>
    <td class="c1">Not graded</td>
  </tr>
  <tr>
    <th class="c0">Due date</th>
    <td class="c1">Friday, 31 October 2026, 11:59 PM</td>
  </tr>
  <tr>
    <th class="c0">Time remaining</th>
    <td class="c1">4 days 2 hours</td>
  </tr>
</table>
`;
const parsedPage = parseAssignmentViewPage(mockAssignViewHtml);
assert(Boolean(parsedPage), "parseAssignmentViewPage returns parsed object");
assert(parsedPage.dueTimestamp !== null, "parseAssignmentViewPage extracted dueTimestamp");
assert(parsedPage.isSubmitted === true, "parseAssignmentViewPage detected submitted status");
assert(parsedPage.timeRemainingText === "4 days 2 hours", "Extracted native time remaining text");

const testDate = new Date(2026, 9, 31, 23, 59).getTime(); // 31 Oct 2026 23:59
const formattedDateStr = formatDueCalendarDate(testDate);
assert(formattedDateStr.includes("Oct") && formattedDateStr.includes("31"), `Formatted date contains '31' and 'Oct' (got '${formattedDateStr}')`);

const threeDaysAway = Date.now() + (3 * 86400000) + 3600000;
const relStr = formatTimeRemaining(threeDaysAway);
assert(relStr.includes("Due in 3 days"), `formatTimeRemaining returns 'Due in 3 days' (got '${relStr}')`);

// -------------------------------------------------------------
// Test 5G: Closed Dates, Cut-off Dates, and Quiz Closes
// -------------------------------------------------------------
console.log("\n--- Sub-test 5G: Closed Dates, Cut-off Dates, and Quiz Closes ---");

// 1. Prefix Stripping in parseMoodleDateString
const prefix1 = parseMoodleDateString("Closed date: Friday, 31 October 2026, 11:59 PM");
assert(prefix1 !== null, "parseMoodleDateString parses 'Closed date: ...'");
const d1 = new Date(prefix1);
assert(d1.getDate() === 31 && d1.getMonth() === 9 && d1.getFullYear() === 2026, "Extracted 31 Oct 2026 from 'Closed date: ...'");

const prefix2 = parseMoodleDateString("Close date: Friday, 31 October 2026, 11:59 PM");
assert(prefix2 !== null, "parseMoodleDateString parses 'Close date: ...'");

const prefix3 = parseMoodleDateString("This quiz will close on Friday, 31 October 2026, 11:59 PM");
assert(prefix3 !== null, "parseMoodleDateString parses 'This quiz will close on ...'");

const prefix4 = parseMoodleDateString("Quiz closes: Friday, 31 October 2026, 11:59 PM");
assert(prefix4 !== null, "parseMoodleDateString parses 'Quiz closes: ...'");

const prefix5 = parseMoodleDateString("Cut-off date: 31/10/2026 23:59");
assert(prefix5 !== null, "parseMoodleDateString parses 'Cut-off date: 31/10/2026 23:59'");

const prefix6 = parseMoodleDateString("Tarikh tutup: Jumaat, 31 Oktober 2026, 11:59 PM");
assert(prefix6 !== null, "parseMoodleDateString parses BM 'Tarikh tutup: ...'");

const prefix7 = parseMoodleDateString("Ditutup pada: 31 Okt 2026, 11:59 PM");
assert(prefix7 !== null, "parseMoodleDateString parses BM 'Ditutup pada: ...'");

// 2. Month-First Date format
const monthFirstTs = parseMoodleDateString("October 31, 2026, 11:59 PM");
assert(monthFirstTs !== null, "parseMoodleDateString parses Month-first 'October 31, 2026'");
const dM = new Date(monthFirstTs);
assert(dM.getDate() === 31 && dM.getMonth() === 9 && dM.getFullYear() === 2026, "Month-first parsed correct date and month");

// 3. parseAssignmentViewPage with Closed date table
const mockClosedPageHtml = `
<table class="generaltable">
  <tr>
    <th class="c0">Submission status</th>
    <td class="c1">No attempt</td>
  </tr>
  <tr>
    <th class="c0">Closed date</th>
    <td class="c1">Friday, 31 October 2026, 11:59 PM</td>
  </tr>
</table>
`;
const parsedClosed = parseAssignmentViewPage(mockClosedPageHtml);
assert(parsedClosed && parsedClosed.dueTimestamp !== null, "parseAssignmentViewPage extracted dueTimestamp from 'Closed date'");
assert(parsedClosed.dateLabel === "Closes", "parseAssignmentViewPage labeled Closed date as 'Closes'");
assert(parsedClosed.isSubmitted === false, "parseAssignmentViewPage detected no attempt");

// 4. parseAssignmentViewPage with Cut-off date table
const mockCutoffPageHtml = `
<table class="generaltable">
  <tr>
    <th class="c0">Cut-off date</th>
    <td class="c1">Sunday, 15 November 2026, 11:59 PM</td>
  </tr>
</table>
`;
const parsedCutoff = parseAssignmentViewPage(mockCutoffPageHtml);
assert(parsedCutoff && parsedCutoff.dueTimestamp !== null, "parseAssignmentViewPage extracted dueTimestamp from 'Cut-off date'");
assert(parsedCutoff.dateLabel === "Cut-off", "parseAssignmentViewPage labeled Cut-off date as 'Cut-off'");

// 5. parseAssignmentViewPage with Quiz Info Box
const mockQuizViewHtml = `
<div class="box py-3 quizinfo">
  <p>This quiz opened at Monday, 1 October 2026, 8:00 AM</p>
  <p>This quiz will close on Friday, 31 October 2026, 11:59 PM</p>
  <p>Time limit: 1 hour</p>
</div>
<div class="quizattemptsummary">
  <h3>Summary of your previous attempts</h3>
  <table class="generaltable">
    <tr><td>State: Finished</td><td>Marks: 10.00/10.00</td></tr>
  </table>
</div>
`;
const parsedQuiz = parseAssignmentViewPage(mockQuizViewHtml);
assert(parsedQuiz && parsedQuiz.dueTimestamp !== null, "parseAssignmentViewPage extracted dueTimestamp from quizinfo paragraph");
assert(parsedQuiz.dateLabel === "Closes", "parseAssignmentViewPage labeled quiz closing date as 'Closes'");
assert(parsedQuiz.isSubmitted === true, "parseAssignmentViewPage detected submitted status from quiz attempt summary");

// 6. parseCourseQuizzesIndex (/mod/quiz/index.php)
const mockQuizIndexHtml = `
<table class="generaltable mod_index">
  <thead>
    <tr>
      <th>Topic</th>
      <th>Name</th>
      <th>Quiz closes</th>
      <th>Grade</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Topic 2</td>
      <td><a href="https://spectrum.um.edu.my/mod/quiz/view.php?id=7001">Quiz 1: Fundamentals (Occ 1)</a></td>
      <td>Friday, 31 October 2026, 11:59 PM</td>
      <td>10.00 / 10.00</td>
    </tr>
    <tr>
      <td>Topic 2</td>
      <td><a href="https://spectrum.um.edu.my/mod/quiz/view.php?id=7002">Quiz 1: Fundamentals (Occ 2)</a></td>
      <td>Friday, 31 October 2026, 11:59 PM</td>
      <td>-</td>
    </tr>
    <tr>
      <td>Topic 5</td>
      <td><a href="https://spectrum.um.edu.my/mod/quiz/view.php?id=7003">Midterm Quiz (Universal)</a></td>
      <td>Friday, 20 November 2026, 5:00 PM</td>
      <td>-</td>
    </tr>
    <tr>
      <td>Topic 1</td>
      <td><a href="https://spectrum.um.edu.my/mod/quiz/view.php?id=7004">Attendance Quiz Week 1</a></td>
      <td>Monday, 10 October 2026, 10:00 AM</td>
      <td>-</td>
    </tr>
  </tbody>
</table>
`;
const quizzesOcc1 = parseCourseQuizzesIndex(mockQuizIndexHtml, "WIX2002", "Project Management", "Occ 1");
assert(quizzesOcc1.length === 2, `parseCourseQuizzesIndex filtered occurrence & attendance (expected 2, got ${quizzesOcc1.length})`);
assert(quizzesOcc1.some(q => q.id === "7001" && q.isSubmittedOnSpectrum === true), "Quiz 1 (Occ 1) is captured and marked Submitted");
assert(quizzesOcc1.some(q => q.id === "7003" && q.isSubmittedOnSpectrum === false), "Midterm Quiz (Universal) is captured");
assert(!quizzesOcc1.some(q => q.id === "7002"), "Quiz 1 (Occ 2) strictly excluded for student Occ 1");
assert(!quizzesOcc1.some(q => q.id === "7004"), "Attendance Quiz strictly excluded");
assert(quizzesOcc1[0].dateLabel === "Closes", "Quiz items receive dateLabel 'Closes'");

// 7. formatDueCalendarDate fallback parsing
const formattedFallback = formatDueCalendarDate(null, "Closed date: Friday, 31 October 2026, 11:59 PM");
assert(formattedFallback.includes("Oct") && formattedFallback.includes("31"), `formatDueCalendarDate parsed fallbackText date (got '${formattedFallback}')`);

console.log(`\n=== All Deadlines Tests Finished: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  throw new Error(`${failed} tests failed!`);
}
