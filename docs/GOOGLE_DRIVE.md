# Download from Google Drive, upload to the website

1. Open a week folder from [the example index](../example-files/README.md).
2. Open `members`, choose **File → Download → Microsoft Excel (.xlsx)**, and save it.
3. Repeat for `attendance` and `drivers`.
4. In the website, click **Choose Excel files** and select all three downloads together, or drag and drop them together. The app detects **Members**, **Attendance**, and **Drivers** from their headers and grid tab names. Only `.xlsx` files are supported.
5. Resolve any review checks, then click **Plan week** once. Sign in as admin. The website uses TomTom estimates with its configured browser API key. Planning saves the original Excel files privately; publishing shares the resulting routes with the team. After editing in Google Sheets, download fresh files and reupload before replanning.

The website uses local files. It requires no Drive API, OAuth client ID, Google account connection or public sharing. Keep the online folders private; sign into Google only when opening/downloading the original Sheets in your own browser.

Members edit three simple tables: **Members** (name, pickup address), **Attendance** and **Drivers** (member names down column A, dates across row 1, Yes/No answers in the grid). Keep the [simple headers](SCHEMA.md) in row 1 and use the same name in every sheet. Pickup addresses are used directly, and attendees need carpool seats unless an optional transport exception is marked. Both grids offer only **Yes** or **No**. Empty uploaded answers default to No in both grids. A Yes driver uses five total seats, including the driver, with no Seats column. No member IDs are needed. Original technical columns and review evidence are preserved in hidden archive tabs. Each week folder contains only the three Google Sheets.

The original historical car-assignment workbooks have a different layout and still need the separate [legacy review workflow](LEGACY.md). Unresolved records and hypothetical example dates still require review for a real schedule.

Keep the date-grid tab names Attendance and Drivers; Members is detected by its Name and Pickup address headers. Filenames and selection order do not matter. Hidden archive tabs and unrelated notes tabs are ignored. A workbook containing all three tables can be selected once. Duplicate tables of the same type are rejected, including duplicates across selected files. Select files from one week at a time. To correct one already loaded table, use the same upload area to select just its replacement; the other detected files remain loaded. An invalid selection is not applied. Missing input types appear under the upload area and keep planning disabled.

Native date/time and boolean cells are supported; text dates/times must remain `YYYY-MM-DD` / `HH:MM`. Excel serial dates use the workbook's date system, without converting through the browser timezone. Hidden rows in the chosen tab still count. Formulas use saved values and are never executed. Download again after recalculation if a formula has no saved result. Files are limited to 5 MB, with Excel input tables within 10,000 rows and 100 columns. All reading and validation happen locally in workers.

See the served `upload-help.html` page for instructions alongside the app. The website’s Template buttons generate `.xlsx` files.

Implementation references: [SheetJS read options](https://docs.sheetjs.com/docs/api/parse-options/) and [date systems](https://docs.sheetjs.com/docs/csf/features/dates/).

## Independent trips and Uber

Keep Attendance as a Yes/No grid. An optional **Own travel** tab in the attendance workbook uses the same names, date headers and Yes/No cells: Yes means the attendee arranges their own travel and needs no carpool seat. An optional **Uber** tab uses the same format for explicitly requested Uber trips. Keep those people Yes in Attendance. Conflicting exceptions are rejected. No extra file or technical column is required.

If confirmed club cars lack seats, the planner proposes Uber groups for the minimum seat shortfall, with up to four passengers at a shared pickup. It shows names, estimated pickup/departure times and destination, and includes these groups in the published plan and Excel download. An admin or rider must book each ride separately; app waiting times, fares and driver availability are not included.

Past dates use a clearly labeled comparison against estimates for matching future weekdays. The attendance dates remain unchanged, and historical comparisons cannot be published as live schedules.
