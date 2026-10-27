# Spectra (SPeCTRUM Companion for Universiti Malaya)

> **Modern, Local-First Chrome Extension (Manifest V3) for Universiti Malaya Students**  
> *Never miss an attendance check-in, impending submission dropbox, or urgent course announcement again.*

[![Manifest V3](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![Local First](https://img.shields.io/badge/Architecture-100%25_Local_Chrome-10B981?logo=googlechrome&logoColor=white)](#-privacy--local-first-security)
[![Universiti Malaya](https://img.shields.io/badge/UM-SPeCTRUM-003366)](https://spectrum.um.edu.my/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Donate: DuitNow](https://img.shields.io/badge/Donate-DuitNow_QR-ED1C24.svg)](#-support--donations)
[![Telegram Bot API](https://img.shields.io/badge/Telegram-Bot_API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)

---

## 📑 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
  - [1. Interactive Attendance & 1-Click Check-In](#1-interactive-attendance--1-click-check-in)
  - [2. Submissions Radar (3-Tier Interactive Color System)](#2-submissions-radar-3-tier-interactive-color-system)
  - [3. Course Announcements & Notices Radar](#3-course-announcements--notices-radar)
  - [4. 1-Click Week Pack Downloader](#4-1-click-week-pack-downloader)
  - [5. Privacy & Local-First Security](#5-privacy--local-first-security)
- [Quick Setup Guide (Under 3 Minutes)](#-quick-setup-guide-under-3-minutes)
  - [Step 1: Download the Extension](#step-1-download-the-extension)
  - [Step 2: Load into Google Chrome](#step-2-load-into-google-chrome)
  - [Step 3: Connect to SPeCTRUM & Set Occurrences](#step-3-connect-to-spectrum--set-occurrences)
  - [Step 4: Enable Phone Telegram Alerts](#step-4-enable-phone-telegram-alerts)
- [Project Architecture](#-project-architecture)
- [Frequently Asked Questions (FAQ)](#-frequently-asked-questions-faq)
- [Support & Donations (DuitNow QR)](#-support--donations)
- [License](#-license)

---

## 🎯 Overview

**Spectra** is an intelligent companion extension designed specifically for Universiti Malaya (UM) students navigating SPeCTRUM (Moodle).

Built strictly as a **pure local Chrome Extension (Manifest V3)**, Spectra runs directly inside your browser without needing external cloud functions, serverless workers, or third-party databases. It eliminates the everyday friction of university portals:

- **Attendance check-in detection**: Notifies you the second attendance opens for your specific tutorial or lecture occurrence.
- **Semi-automated check-in**: Instead of navigating multiple menus, click **Submit (Mark Present)** in Spectra; it auto-navigates to the check-in form, selects *Present / Hadir*, fills the password (if required), submits the form, and updates the popup in real time.
- **Interactive submissions radar**: Tracks all assignments, quizzes, Turnitin submissions, and workshops with a dynamic 3-color tier system (Green for submitted, Yellow for pending, Red for under 24 hours).
- **Telegram push notifications**: Sends instant alerts directly to your mobile phone when attendance opens or deadlines approach.

---

## ⚡ Key Features

### 1. Interactive Attendance & 1-Click Check-In

- **Occurrence Isolation:** Filters class sessions strictly for your enrolled occurrence (e.g. `Occ 1`, `Occ 2`, `Group 1`, `Tutorial 3`). You will never see or accidentally check into another group's attendance.
- **Live Radar Beacon:** When attendance opens for your occurrence, an interactive submission container lights up with a pulsing live beacon (`ATTENDANCE OPEN`).
- **Semi-Automated 1-Click Submit:** Click **`⚡ Submit (Mark Present) →`**. Spectra opens the attendance page in SPeCTRUM, automatically selects **Present / Hadir**, enters the class passcode if required, and submits the form.
- **Instant Real-Time Popup Update:** As soon as attendance is confirmed on SPeCTRUM, Spectra's popup automatically updates to show **Present ✅** without needing a manual refresh.
- **Telegram Open Alert Toggle:** Includes a quick toggle button (`Telegram Open Alert`) to enable or disable mobile alerts whenever attendance opens for your group.
- **Passcode Accordion:** Easily enter or view session passwords in an expandable drawer before submitting.
- **Attendance History & Analytics:** Tracks your semester check-in rate, present/late/absent counts, and points breakdown.

---

### 2. Submissions Radar (3-Tier Interactive Color System)

- **Top-to-Bottom Course Discovery:** Automatically scans Moodle via native AJAX (`core_course_get_contents`), Assignment Overviews (`/mod/assign/index.php`), and course pages (`/course/view.php`) to capture all dropboxes, online quizzes, workshops, and Turnitin submissions—including Week 14 final project dropboxes.
- **Occurrence Filtering:** Strictly excludes submissions belonging to other tutorial groups while keeping universal assignments and your group's dropboxes.
- **Interactive 3-Tier Color Hierarchy:**
  - 🟢 **Green (`.card-state-submitted`): Submitted / Completed**
    - Soft mint-emerald surface gradient with a bold green accent edge.
    - Badged with `✓ Submitted` and emerald status beacon.
    - Interactive custom checkbox checked.
  - 🟡 **Yellow (`.card-state-pending`): Pending**
    - Warm amber gradient with an amber accent edge.
    - Badged with `⏳ Pending` or `🟡 This Week` (displays overdue days if past due date).
    - Status chip labeled `Pending Submission`.
  - 🔴 **Red (`.card-state-urgent`): Under 24 Hours**
    - Vibrant rose surface gradient with an alert rose accent edge.
    - Badged with `< 24h Left` and live pulsing radar ring.
    - Live ticking countdown pill: `⚡ Xh Ym left`.
- **Tactile Micro-Interactions:** Cards elevate on hover (`transform: translateY(-2px)`) with glowing state-colored drop shadows. Checkboxes feature smooth scale-pop animations (`scale(1.08)` on hover, `scale(1.05)` when checked), immediately flipping the card between states.
- **Direct Dropbox Jump:** Tactical pill buttons link directly to each assignment's SPeCTRUM submission page.

---

### 3. Course Announcements & Notices Radar

- **Universal Forum Scraper:** Scrapes lecturer announcements and news forums across all enrolled subjects.
- **Instant Search & Course Filter:** Quickly filter announcements by subject code or search for keywords like *"exam"*, *"cancelled"*, or *"replacement"*.
- **Mobile Push Alerts:** Forwards new lecturer announcements straight to your phone via Telegram.

---

### 4. 1-Click Week Pack Downloader

- Discovers lecture slides, lab sheets, and tutorial worksheets across your course pages.
- Categorizes materials by week (Week 1 through Week 14) and downloads them in neatly structured folders:  
  `Downloads/Spectra/{Course_Code}/Week_{N}/`

---

### 5. Privacy & Local-First Security

- **100% Local Processing:** Runs entirely inside your Chrome browser using Manifest V3. No Cloudflare worker, external server, or database required.
- **Zero Third-Party Tracking:** No student passwords, analytics, or cookies are ever transmitted to any third-party server.
- **Automatic Session Discovery:** Uses standard Chrome cookie permissions to discover your active `MoodleSession` on `spectrum.um.edu.my`. No manual token copying required.

---

## 💻 Quick Setup Guide (Under 3 Minutes)

Follow these steps to get Spectra running on your computer.

### **Prerequisites**
- **Google Chrome** (or Chromium-based browsers: Brave, Microsoft Edge, Arc).
- An active Universiti Malaya student login on [SPeCTRUM](https://spectrum.um.edu.my/).
- *(Optional)* A free [Telegram](https://telegram.org/) account for phone push alerts.

---

### **Step 1: Download the Extension**

#### **Option A: Using Git (Recommended)**
```bash
git clone https://github.com/norman-AI-2025/spectra_um.git
cd spectra_um
```

#### **Option B: Direct ZIP Download**
1. Visit the repository on GitHub: [`https://github.com/norman-AI-2025/spectra_um`](https://github.com/norman-AI-2025/spectra_um).
2. Click the green **Code** button and select **Download ZIP**.
3. Extract the ZIP file to a permanent folder on your laptop (e.g. `Documents/spectra_um`).

---

### **Step 2: Load into Google Chrome**

1. Open Chrome and navigate to:
   ```
   chrome://extensions/
   ```
2. In the top-right corner, toggle **Developer mode** to **ON**.
3. In the top-left corner, click **Load unpacked**.
4. In the file picker, select the `spectra_um` folder (the folder containing `manifest.json`).
5. Click the Chrome toolbar **puzzle icon** (Extensions) 🧩 and **Pin 📌** Spectra so it stays visible in your toolbar.

---

### **Step 3: Connect to SPeCTRUM & Set Occurrences**

1. Log into [SPeCTRUM](https://spectrum.um.edu.my/my/) in Chrome with your `@siswa.um.edu.my` account.
2. Click the **Spectra** icon in your browser toolbar. Spectra will automatically detect your login and enrolled courses.
3. **Configure Your Tutorial / Lab Occurrence:**
   - Go to the **Attendance** tab in Spectra.
   - Select your course from the dropdown.
   - Enter your registered occurrence (e.g. `Occ 1`, `Occ 2`, `Group 1`) and click **Save**.
   - Repeat for your other enrolled subjects.

---

### **Step 4: Enable Phone Telegram Alerts**

Receive real-time push alerts on your phone whenever attendance opens for your occurrence, when an assignment is due in less than 24 hours, or when an instructor posts an announcement.

1. **Create Your Telegram Bot:**
   - Open Telegram and search for [`@BotFather`](https://t.me/BotFather).
   - Send `/newbot` and follow the prompts to choose a name and username.
   - BotFather will provide your **HTTP API Bot Token** (e.g. `7123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`). Copy it.
2. **Find Your Telegram Chat ID:**
   - Search for [`@userinfobot`](https://t.me/userinfobot) on Telegram and send `/start`.
   - Copy the numeric `Id` it replies with (e.g. `987654321`).
   - Open your new bot in Telegram and click **Start** (or send any text).
3. **Save in Spectra:**
   - Open Spectra → click the **Settings** tab.
   - Paste your **Bot Token** and **Chat ID**.
   - Click **"Send Test Telegram"** to verify the connection.
   - Scroll down and click **"Save Settings"**.

---

## 📂 Project Architecture

```
spectra_um/
├── manifest.json              # Chrome Manifest V3 declaration & permission boundaries
├── popup.html                 # Apple Bento-grid dashboard (Submissions, Attendance, Notices, Settings)
├── popup.css                  # Modern design system, state colors, micro-animations
├── popup.js                   # Frontend controller, reactive state manager, 3-tier card renderer
├── background.js              # Service worker, periodic attendance alarms, Telegram push dispatcher
├── content.js                 # Content script for SPeCTRUM pages (semi-automated Present check-in)
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
    ├── test-deadlines.js      # Comprehensive unit tests for submissions & occurrence filtering
    └── test-attendance.js     # Comprehensive test suite for attendance parsing & occurrence isolation
```

---

## ❓ Frequently Asked Questions (FAQ)

<details>
<summary><b>1. Does Spectra require Cloudflare or any cloud server?</b></summary>
<br>
<b>No.</b> Spectra is completely local and runs directly in your Chrome browser. There are no cloud dependencies or external relays required.
</details>

<details>
<summary><b>2. How does the 1-click attendance check-in work?</b></summary>
<br>
When attendance is open for your occurrence, Spectra displays an interactive banner and sends a Telegram alert. Clicking <b>Submit (Mark Present)</b> opens the check-in page in SPeCTRUM. Spectra's content script automatically selects <i>Present / Hadir</i>, fills the password if required, and submits the form. The extension popup then immediately updates to reflect that attendance has been recorded.
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
You can enter the session password in the password drawer inside the attendance banner before clicking Submit. Spectra will automatically fill the password into the form.
</details>

<details>
<summary><b>5. Are my student credentials safe?</b></summary>
<br>
Yes. Spectra never sees or stores your password. It communicates directly with Universiti Malaya's official SPeCTRUM servers via your existing browser session cookie, stored safely on your machine.
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