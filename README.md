# Spectra — SPeCTRUM Companion for Universiti Malaya

> **Modern, Local-First Chrome Extension (Manifest V3) for Universiti Malaya Students**  
> *Never miss an attendance check-in, impending submission dropbox, or urgent course announcement again.*

<div align="center">

[![Manifest V3](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![Local First Architecture](https://img.shields.io/badge/Architecture-100%25_Local_Chrome-10B981?logo=googlechrome&logoColor=white)](#-privacy--local-first-security)
[![Universiti Malaya](https://img.shields.io/badge/UM-SPeCTRUM-003366?logo=academia&logoColor=white)](https://spectrum.um.edu.my/)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![Tests Passing](https://img.shields.io/badge/Tests-All_Suites_Passing-brightgreen?logo=node.js&logoColor=white)](#-developer-guide--test-suite)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Donate: DuitNow](https://img.shields.io/badge/Donate-DuitNow_QR-ED1C24.svg)](#-support--donations)

</div>

---

## 📑 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
  - [1. Attendance Radar & 1-Click Check-In](#1-attendance-radar--1-click-check-in)
  - [2. Submissions Radar (3-Tier Interactive Color System)](#2-submissions-radar-3-tier-interactive-color-system)
  - [3. Course Notices & Forum Radar](#3-course-notices--forum-radar)
  - [4. Mobile Telegram Push Notifications](#4-mobile-telegram-push-notifications)
  - [5. 1-Click Week Pack Downloader](#5-1-click-week-pack-downloader)
  - [6. Apple Liquid Glass UI Design](#6-apple-liquid-glass-ui-design)
  - [7. Privacy & Local-First Security](#7-privacy--local-first-security)
- [Installation & Setup Guide](#-installation--setup-guide)
  - [Prerequisites](#prerequisites)
  - [Step 1: Download Spectra from GitHub](#step-1-download-spectra-from-github)
  - [Step 2: Load Extension into Chrome](#step-2-load-extension-into-chrome)
  - [Step 3: Connect to SPeCTRUM & Set Occurrences](#step-3-connect-to-spectrum--set-occurrences)
  - [Step 4: Enable Phone Telegram Alerts](#step-4-enable-phone-telegram-alerts)
  - [Step 5 (Optional): 24/7 Cloudflare Relay Worker](#step-5-optional-247-cloudflare-relay-worker)
- [How to Update Spectra](#-how-to-update-spectra)
- [Developer Guide & Test Suite](#-developer-guide--test-suite)
- [Project Architecture](#-project-architecture)
- [Frequently Asked Questions (FAQ)](#-frequently-asked-questions-faq)
- [Support & Donations (DuitNow QR)](#-support--donations)
- [License](#-license)

---

## 🎯 Overview

**Spectra** is a companion extension designed specifically for Universiti Malaya (UM) students using the SPeCTRUM (Moodle) learning portal.

Built as a **pure local Chrome Extension (Manifest V3)**, Spectra runs directly inside your browser without needing external servers, third-party databases, or complex configurations. It eliminates the everyday friction of university portals:

- **Attendance check-in detection**: Notifies you the instant attendance opens for your specific tutorial or lecture occurrence.
- **Semi-automated 1-click check-in**: Automatically opens the check-in form, selects *Present / Hadir*, fills the session password (if required), submits the form, and updates the popup in real time.
- **Submissions radar**: Scans all course dropboxes, quizzes, Turnitin assignments, and workshops with a dynamic 3-tier color hierarchy (Green for submitted, Yellow for pending, Red for under 24 hours).
- **Telegram push alerts**: Delivers instant alerts directly to your mobile phone for open attendance, impending submission deadlines ($\le 24$h), and new course announcements with summaries.
- **Course material downloads**: Batch-downloads lecture slides and tutorial worksheets into clean, week-by-week folders (`Week 1` through `Week 14`).

---

## ⚡ Key Features

### 1. Attendance Radar & 1-Click Check-In

- **Striped Capsule Progress Gauge**: Modern stadium pill progress indicator showing your semester attendance rate alongside dynamic status insights.
- **Strict Occurrence Isolation**: Filters class sessions strictly for your enrolled occurrence (e.g. `Occ 1`, `Occ 2`, `Group 3`, `Tutorial 4`, or multi-occurrence formats like `3, 6, 9`). You will never accidentally check into another group's attendance.
- **Live Radar Beacon**: When attendance opens for your group, an interactive card lights up with a pulsing live beacon (`ATTENDANCE OPEN`).
- **Semi-Automated 1-Click Submit**: Click **`⚡ Submit (Mark Present) →`**. Spectra opens the attendance page in SPeCTRUM, automatically selects **Present / Hadir**, enters the class passcode if required, and submits the form.
- **Instant Real-Time Update**: As soon as attendance is recorded on SPeCTRUM, Spectra's popup immediately updates to show **Present ✅** without requiring a page refresh.
- **Passcode Accordion**: Easily enter or view session passwords in an expandable drawer before submitting.
- **Attendance History & Analytics**: Tracks your semester attendance percentage, present/late/absent counts, and points breakdown.

---

### 2. Submissions Radar (3-Tier Interactive Color System)

- **Deep Course Discovery**: Automatically scans Moodle via native AJAX (`core_course_get_contents`), Assignment Overviews (`/mod/assign/index.php`), and course pages (`/course/view.php`) to capture all dropboxes, online quizzes, workshops, and Turnitin assignments—including Week 14 final project dropboxes.
- **Occurrence Filtering**: Excludes dropboxes intended for other occurrences while retaining universal assignments and your group's submissions.
- **3-Tier Interactive Color Hierarchy**:
  - 🟢 **Green (`.card-state-submitted`): Submitted / Completed**
    - Soft emerald surface gradient with a green accent edge.
    - Badged with `✓ Submitted` and emerald status beacon.
    - Interactive custom checkbox marked as complete.
  - 🟡 **Yellow (`.card-state-pending`): Pending**
    - Warm amber gradient with an amber accent edge.
    - Badged with `⏳ Pending` or `🟡 This Week` (displays overdue days if past due date).
  - 🔴 **Red (`.card-state-urgent`): Under 24 Hours**
    - Alert rose surface gradient with a high-visibility accent edge.
    - Badged with `< 24h Left` and live pulsing radar ring.
    - Live ticking countdown pill: `⚡ Xh Ym left`.
- **Direct Dropbox Jump**: Click directly into each assignment's SPeCTRUM submission dropbox with one tap.

---

### 3. Course Notices & Forum Radar

- **Universal Forum Scraper**: Scrapes lecturer announcements and news forums across all enrolled subjects.
- **Course Code & Course Name Clarity**: Every notice displays both the course code and full subject title (e.g. `WIX2002 - Software Engineering Project Management`).
- **Concise Summaries**: Automatically parses forum discussion posts and extracts a clean, summarized excerpt (~280 characters) free of HTML tags.
- **Instant Search & Subject Filter**: Filter announcements by subject code or search for keywords like *"midterm"*, *"replacement"*, or *"lab"*.

---

### 4. Mobile Telegram Push Notifications

Connect Spectra directly to your personal Telegram account to receive instant notifications on your phone:

| Alert Type | Trigger | Content Delivered |
|---|---|---|
| **Attendance Open** | Class attendance opens for your occurrence | Direct submission link, occurrence, session time & password |
| **Urgent Deadline** | Submission deadline $\le 24$ hours away | Assignment title, course code, hours remaining & direct dropbox link |
| **New Course Notice** | Lecturer posts a new forum announcement | Course code, course name, notice title, author & clean text summary |

> [!NOTE]
> Telegram alerts are strictly deduplicated and sent **once per event**. No spam or session expired warnings.

---

### 5. 1-Click Week Pack Downloader

- Discovers lecture slides, lab sheets, and tutorial worksheets across your course pages.
- Automatically categorizes materials by week (Week 1 through Week 14) and downloads them in neatly organized folders:  
  `Downloads/Spectra/{Course_Code}/Week_{N}/`

---

### 6. Apple Liquid Glass UI Design

- **Light Theme Only**: Engineered with an airy light aesthetic, inspired by modern macOS and iOS interface design.
- **Frosted Translucent Surfaces**: Apple-style glassmorphism cards (`backdrop-filter: blur(20px)`), subtle micro-borders, and soft natural shadows.
- **Striped Capsule Gauges**: Inspired by clean analytics widgets, featuring an animated stadium-pill gauge with baby-blue vertical tick stripes.
- **Collapsible Occurrences Setup**: Keep your occurrence configuration neat and compact with expandable drawers.

---

### 7. Privacy & Local-First Security

- **100% Local Processing**: Runs entirely inside your browser using standard Chrome Manifest V3 APIs.
- **Zero Third-Party Tracking**: No student passwords, analytics, or cookies are ever transmitted to any third-party analytics service.
- **Safe Authentication**: Communicates directly with Universiti Malaya's official `spectrum.um.edu.my` servers using your existing browser session cookie (`MoodleSession`).

---

## 💻 Installation & Setup Guide

Get Spectra running in **under 3 minutes** by following this step-by-step guide.

### Prerequisites

- **Google Chrome** (or any Chromium-based browser: Brave, Microsoft Edge, Arc, Opera, Vivaldi).
- An active student login on [SPeCTRUM Universiti Malaya](https://spectrum.um.edu.my/).
- *(Optional)* A free [Telegram](https://telegram.org/) account for phone push alerts.

---

### Step 1: Download Spectra from GitHub

Choose **Option A** (recommended for developers) or **Option B** (easy for everyone):

#### **Option A: Using Git (Recommended)**
Open your terminal (Terminal on Mac, PowerShell or Git Bash on Windows) and run:
```bash
git clone https://github.com/norman-AI-2025/spectra_um.git
cd spectra_um
```

#### **Option B: Download ZIP (No Git Required)**
1. Visit the repository: [https://github.com/norman-AI-2025/spectra_um](https://github.com/norman-AI-2025/spectra_um).
2. Click the green **`Code`** button at the top-right of the file list.
3. Select **`Download ZIP`**.
4. Extract the downloaded `.zip` file into a permanent folder on your computer (e.g. `Documents/spectra_um`).

> [!IMPORTANT]
> Keep the extracted folder in a permanent location. Do not delete or move it after loading it into Chrome, or the extension will be disabled.

---

### Step 2: Load Extension into Chrome

1. Open Google Chrome and enter this address in the URL bar:
   ```
   chrome://extensions/
   ```
2. In the top-right corner, turn **Developer mode** toggle **ON**.
3. In the top-left corner, click the **Load unpacked** button.
4. In the file picker, select the `spectra_um` folder (the folder containing `manifest.json`).
5. Click **Select Folder** (or **Open**).
6. Click the Chrome toolbar **puzzle icon** (Extensions) 🧩 and click the **Pin 📌** icon next to **Spectra** so it stays visible in your toolbar.

---

### Step 3: Connect to SPeCTRUM & Set Occurrences

1. Log in to [SPeCTRUM](https://spectrum.um.edu.my/my/) in Google Chrome using your `@siswa.um.edu.my` credentials.
2. Click the **Spectra** icon in your browser toolbar. Spectra will automatically discover your active session and display your enrolled courses.
3. **Configure Your Tutorial / Lab Occurrences:**
   - Go to the **Attendance** tab in Spectra.
   - Click the **Occurrences Setup** header to expand the configuration drawer.
   - For each enrolled course, select or enter your registered occurrence (e.g. `Occ 1`, `Occ 2`, `Group 1`, `Tutorial 3`).
   - Click **Save Occurrences**.

> [!TIP]
> Setting your occurrence ensures that Spectra only tracks attendance and submissions relevant to your tutorial group, filtering out sessions from other groups.

---

### Step 4: Enable Phone Telegram Alerts

Receive real-time push alerts on your phone whenever attendance opens, when an assignment is due in $\le 24$ hours, or when a lecturer posts a notice.

#### 1. Create Your Personal Telegram Bot
1. Open Telegram on your phone or computer.
2. Search for [`@BotFather`](https://t.me/BotFather) (verified bot with blue checkmark).
3. Send the command:
   ```text
   /newbot
   ```
4. Follow the prompts:
   - Enter a display name for your bot (e.g., `My Spectra Bot`).
   - Choose a unique username ending in `bot` (e.g., `john_spectra_um_bot`).
5. BotFather will reply with your **HTTP API Token** (e.g. `7123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`). Copy this token.

#### 2. Get Your Personal Chat ID
1. Search for [`@userinfobot`](https://t.me/userinfobot) on Telegram and click **Start** (or send `/start`).
2. The bot will reply with your user information. Copy the numeric **`Id`** (e.g. `987654321`).
3. Now, open the bot you just created in Step 1 and click **Start** (or send `/start` to it). This allows your bot to message you.

#### 3. Save Credentials in Spectra
1. Open Spectra from your browser toolbar.
2. Switch to the **Settings** tab.
3. Paste your **Telegram Bot Token** and **Telegram Chat ID**.
4. Click **Send Test Alert** to verify your connection. You should immediately receive a test notification on your phone!
5. Scroll down and click **Save Settings**.

---

### Step 5 (Optional): 24/7 Cloudflare Relay Worker

If you want Spectra to monitor attendance and deadlines **24/7 in the cloud**—even when your laptop is closed, sleeping, or turned off—you can optionally deploy the included Cloudflare Worker.

1. Install Cloudflare Wrangler CLI:
   ```bash
   npm install -g wrangler
   ```
2. Log in to your free Cloudflare account:
   ```bash
   wrangler login
   ```
3. Deploy the worker:
   ```bash
   npm run deploy
   ```
4. In Spectra **Settings**, paste your Worker URL (e.g. `https://spectra-relay.<username>.workers.dev`) and click **Sync Session to Cloud**.

> [!NOTE]
> The Cloudflare Worker is completely optional. The Chrome extension functions 100% locally on its own without it!

---

## 🔄 How to Update Spectra

When new updates or bug fixes are released on GitHub, update your extension:

### If you installed via Git:
```bash
cd spectra_um
git pull origin redesign/unslop-clean-ui
```
Then navigate to `chrome://extensions/` and click the **Reload 🔄** icon on the Spectra card.

### If you downloaded via ZIP:
1. Download the new ZIP from GitHub.
2. Replace the contents of your existing `spectra_um` folder with the new files.
3. Open `chrome://extensions/` and click the **Reload 🔄** icon on Spectra.

---

## 🧪 Developer Guide & Test Suite

Spectra includes an automated test harness covering the Cloudflare Worker, Telegram dispatcher, occurrence matching engine, iCalendar parsing, and deduplication logic.

### Running Tests
Make sure Node.js (v18+) is installed, then run:
```bash
npm test
```

### Test Suite Breakdown
- **`cloud/test-worker.js`**: Validates CORS preflights, bearer authentication, session persistence, attendance auto-submission, announcement polling, and error handling (42 tests).
- **`cloud/test-telegram.js`**: Validates chat ID sanitization, HTML escaping, summary extraction, and message formatting (58 tests).
- **`cloud/test-attendance.js`**: Validates multi-occurrence parsing, group isolation (`Occ 1` vs `Occ 2`), and Malay/English label matching.
- **`cloud/test-ical-ajax.js`**: Validates RFC 5545 iCalendar parsing, Moodle AJAX `core_course_get_contents`, Turnitin dropbox detection, and automatic iCal token discovery (44 tests).
- **`cloud/test-dropbox-dedup.js`**: Validates deadline fingerprinting and deduplication between iCal feeds and course web dropboxes.

---

## 📂 Project Architecture

```
spectra_um/
├── manifest.json              # Chrome Manifest V3 declaration & permission boundaries
├── popup.html                 # Apple Bento-grid dashboard (Submissions, Attendance, Notices, Settings)
├── popup.css                  # Modern Apple Liquid Glass design system, striped pill gauges, light theme
├── popup.js                   # Frontend reactive controller, 3-tier card renderer, occurrence manager
├── background.js              # Background service worker, periodic alarm poller, Telegram push dispatcher
├── content.js                 # Content script for SPeCTRUM pages (semi-automated Present check-in)
├── wrangler.toml              # Cloudflare Worker configuration & 3-minute cron triggers
├── assets/
│   └── duitnow-qr.png         # DuitNow QR code for donations
├── icons/                     # Extension branding icons (16px, 32px, 48px, 128px)
├── utils/
│   ├── moodleApi.js           # Dynamic CSRF sesskey discovery & enrolled course scraper
│   ├── calendar.js            # Live Moodle calendar pipeline & deadline deduplication
│   ├── courses.js             # Live courses & course announcement forum scrapers
│   ├── attendance.js          # Multi-activity attendance parser, all-tabs reader & check-in submitter
│   ├── telegram.js            # Telegram Bot API dispatcher, formatting & sanitization
│   └── parser.js              # DOM & RegEx parser for calendar, courses, forums, dropboxes, attendance
└── cloud/
    ├── cloud-relay-worker.js  # 24/7 Cloudflare Worker relay for background attendance & deadlines
    ├── run-tests.js           # Main test runner executing all test suites
    ├── test-worker.js         # Cloud Relay worker automated test suite
    ├── test-telegram.js       # Telegram formatting and summary parser tests
    ├── test-attendance.js     # Occurrence isolation & attendance parsing tests
    ├── test-deadlines.js      # Deadline parsing & urgency ranking tests
    ├── test-ical-ajax.js      # RFC 5545 iCal & AJAX core_course_get_contents tests
    └── test-dropbox-dedup.js  # Deadline fingerprinting & deduplication tests
```

---

## ❓ Frequently Asked Questions (FAQ)

<details>
<summary><b>1. Does Spectra require a cloud server or paid subscription?</b></summary>
<br>
<b>No.</b> Spectra is 100% free, open-source, and local-first. It runs directly inside your Chrome browser using Manifest V3. No paid accounts, servers, or external databases are required.
</details>

<details>
<summary><b>2. How does the 1-click attendance check-in work?</b></summary>
<br>
When an attendance session opens for your occurrence, Spectra displays a live beacon card and sends a Telegram alert. Clicking <b>⚡ Submit (Mark Present)</b> opens the attendance check-in page in SPeCTRUM. Spectra automatically selects <i>Present / Hadir</i>, fills the session password (if entered), and submits the form.
</details>

<details>
<summary><b>3. How does Spectra know which class occurrence belongs to me?</b></summary>
<br>
In the Attendance tab, you configure your occurrence (e.g. <code>Occ 1</code>). Spectra's matching engine isolates group headers, descriptions, and activity titles:
- Sessions matching <code>Occ 1</code> or universal sessions (<code>All students</code>) are included.
- Sessions for other occurrences (e.g. <code>Occ 2</code>) are strictly excluded from metrics, attendance calculations, and alerts.
</details>

<details>
<summary><b>4. What if a lecturer sets an attendance password?</b></summary>
<br>
You can enter the session password in the password drawer inside the attendance card before clicking Submit. Spectra will automatically fill the password into the form when submitting.
</details>

<details>
<summary><b>5. Are my student credentials safe?</b></summary>
<br>
Yes. Spectra never sees, requests, or stores your student password. It communicates directly with Universiti Malaya's official SPeCTRUM servers via your existing browser session cookie, stored safely on your machine.
</details>

<details>
<summary><b>6. What Telegram alerts will I receive?</b></summary>
<br>
Spectra only sends Telegram alerts for 3 specific events:
1. <b>Open attendance submission</b> matching your occurrence.
2. <b>New course notices</b> with course code, course name, and a clean summary.
3. <b>Impending submission deadlines</b> due in 24 hours or less.
</details>

---

## ☕ Support & Donations

Spectra is an independent, open-source project created with ❤️ to empower Universiti Malaya students to stay on top of coursework, attendance, and deadlines.

If Spectra saved you from an absent mark, alerted you to an urgent midnight submission, or helped you organize your semester materials, consider supporting ongoing maintenance and future development!

<div align="center">

<br>

<img src="assets/duitnow-qr.png" alt="DuitNow QR - Malaysia National QR" width="280" style="border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.15);" />

<br><br>

### **Scan to Support via DuitNow QR**
*Compatible with all Malaysian Banking Apps & e-Wallets:*  
**Touch 'n Go eWallet** • **MAE by Maybank** • **GrabPay** • **ShopeePay** • **CIMB OCTO** • **Bank Islam** • **Hong Leong Connect** • **Public Bank** • **RHB Mobile**

Every contribution directly supports ongoing updates, bug fixes, and new features for UM students! ❤️

</div>

---

## 📄 License

This project is open-source and licensed under the [MIT License](LICENSE).

```text
Copyright (c) 2026 Norman Lee

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
```
