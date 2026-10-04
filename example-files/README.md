# Website examples on Google Drive

[Open all example weeks](https://drive.google.com/drive/folders/1zpo3Ka3pGX4t6dHPab-BBYuBSbuwqeld)

| Example | Google Drive folder                                                                     |
| ------- | --------------------------------------------------------------------------------------- |
| Week 1  | [Open folder](https://drive.google.com/drive/folders/17ln45ZwXJQ5VDp7lH833FNZQAwDPNlY0) |
| Week 3  | [Open folder](https://drive.google.com/drive/folders/1hDyiCbETQT8CSl--1ktoBiviTqTtNUNd) |
| Week 4  | [Open folder](https://drive.google.com/drive/folders/1esCMrurmU-G8ZTJnqqnAH41BlrSndlJq) |
| Week 5 (Sep 21–24) | [Open folder](https://drive.google.com/drive/folders/1TGw3g3RqONaK9I7mfNGQT7W22lFitGIO) |

Each week contains only three editable Google Sheets: `members`, `attendance`, and `drivers`. The former README and review archive files were removed from Drive and backed up locally. Access is restricted to the connected Drive account; these links do not grant access to anyone else.

## Test with the website

1. Open the Google Drive folder for week 1, 3, 4, or 5 above.
2. Open each of its three Sheets: `members`, `attendance`, and `drivers`.
3. In each Sheet, choose **File → Download → Microsoft Excel (.xlsx)**.
4. In the website, click **Choose Excel files** and select all three downloads together, or drag and drop them together. Their roles are detected automatically. Only `.xlsx` files are accepted.
5. Resolve the displayed review checks, then click **Plan week**. TomTom routing is the default and requires the configured browser key. Past weeks use a labeled comparison with estimates for matching future weekdays.
6. After editing a Sheet, download it again and reupload it. The old plan becomes stale until you replan.

No Google sign-in or OAuth setup is needed in the website. Files are parsed in your browser and saved privately for the admin when planning; team members receive only published routes. The app does not fetch or update Drive files.

Each Sheet has one simple visible table. **Members** has Name and Pickup address. **Attendance** and **Drivers** have names down column A and dates across row 1, with Yes/No answers in the grid. Keep those tab names so the app can distinguish the grids. All three Sheets share matching grid and header formatting. Yes is green, No is red, and names and answers use Arial 11. Pickup addresses are used directly; attendees need carpool seats unless marked in the optional Own travel or Uber tab. Both grids offer Yes or No only; unanswered attendance is filled with No. Use the same name everywhere; members do not need IDs or technical columns. Keep the [input headers](../docs/SCHEMA.md) in row 1. Original data and review evidence are preserved in hidden archive tabs, which the website ignores. See [file preparation](../docs/GOOGLE_DRIVE.md).

These sheets contain real source records with unresolved identity, attendance and pickup information. The October 2026 dates still need review for a real schedule. Driver Yes entries now follow the corresponding weekly car arrangements; other driver entries are No. Attendance has no blank cells. Members who will drive choose Yes; the planner uses five total seats, including the driver. No Seats column is required.

Review actual dates, attendance, pickups and current driver availability before planning. The website no longer creates hypothetical test copies automatically. Car cards initially show driver and riders; **Show route** expands the pickup sequence and destination.

Week 5 follows the confirmed September 21–24 dates and reference car-heading drivers. Its Attendance workbook has an Own travel tab for Monday’s and Wednesday’s independent trips. Friday is excluded. Its three Sheets contain no old archive tabs.

Each local week folder intentionally contains only a README with links. The previous local examples are preserved in the ignored `data/private/archive/pre-google-drive-examples-2026-09-20/` directory.
