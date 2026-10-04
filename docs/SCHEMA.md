# Input sheets

Upload Microsoft Excel (`.xlsx`) files only. The three Google Sheets share light-gray headers, thin grid borders, and a shaded name column. Answers use Arial 11, with green Yes and red No; color rules update when values change. Names use consistent capitalization, spacing, and Arial 11.

| Sheet      | Layout                                                                    |
| ---------- | ------------------------------------------------------------------------- |
| Members    | Name in column A, Pickup address in column B                              |
| Attendance | Name in column A, practice dates across row 1, Yes/No answers in the grid |
| Drivers    | Name in column A, practice dates across row 1, Yes/No answers in the grid |

Keep the grid tab names **Attendance** and **Drivers** so the uploader can distinguish them. Filenames and selection order do not matter. A1 must be **Name**; date headings must be unique native Excel dates or `YYYY-MM-DD` text. Use the same name across all three sheets. Matching ignores case and extra whitespace but never merges nicknames or initials. Different people need distinct names; no member IDs are required.

- Pickup addresses are used directly, without a separate confirmation step.
- Attendance **Yes** means attending and needing a carpool seat unless an Own travel or Uber exception applies; **No** means not attending on that date. Every attendance cell is Yes or No; empty uploaded cells default to No. Only Yes/No are dropdown choices.
- Drivers **Yes** offers to drive with **five total seats, including the driver**. No or blank means the person is not offered as a driver. There is no Seats column in the grid.

The conversion preserves existing answers, fills unanswered attendance with No, and uses No for member/date pairs that had no signup or driver offer. Existing practice dates still need review for a real schedule. Original technical and review tabs are hidden archives and are excluded from import.

Older row-based simple sheets remain compatible. Their extra Pickup confirmed? and Travel columns are ignored; their explicit driver seat counts remain supported. New templates use the date-grid layout and the selected practice dates, or today's New York date when none is selected.

The advanced canonical format below remains supported for pickup overrides, readiness times, coordinates, and individual route limits. Unknown extra columns are discarded. `schemaVersion: 1` is an internal/export property, not a fourth input file.

## Excel uploads

Use **File → Download → Microsoft Excel (.xlsx)** in each formatted Google Sheet, then select all three downloads together in **Choose Excel files**, or drop them into that area. The app identifies Members from its headers and the two date grids from their Attendance/Drivers tab names; filenames and selection order do not matter. A workbook with all three tables can be selected once. Hidden archive tabs and unrelated notes tabs are ignored; duplicate input types in one selection are rejected. You can replace a single loaded table through the same upload area. Missing inputs keep planning disabled, and failed selections are not partially applied. Keep unmerged headers in row 1; this upload path does not infer identities or interpret the original historical car layouts.

Native Excel date cells are converted to `YYYY-MM-DD` using the workbook's 1900/1904 date system. Native time cells become `HH:MM` in the app's New York wall-time context, without browser-timezone shifts. Date cells with a time component and time cells with dates/seconds are rejected rather than silently shortened. Text dates/times must already use the canonical formats; ambiguous locale strings are not guessed. Boolean TRUE/FALSE cells become lowercase only in `attending` and `available`; unknown stays unknown. Formatted numeric IDs retain leading zeroes. Formula cells use saved results, never recalculation or external links; a missing result or spreadsheet error must be fixed before import.

Files must be smaller than 5 MB, with Excel input tables within 10,000 rows and 100 columns; oversized/truncated ranges fail visibly. Reading runs in a worker with a timeout. Hidden rows in the selected visible sheet are still imported, so hiding a row does not remove a member's record. Validation issues identify the uploaded workbook, chosen tab and original Excel row. CSV remains an internal normalization format used by the developer tools.

Successful upload does not mean the data is ready for a real schedule. The review panel identifies missing pickups by column. Invalid grid choices identify the exact cell, such as C7. Repeated pickup checks appear once per member row, with all affected dates retained. **Download review (.xlsx)** exports names, source rows, dates and instructions into Required changes and, when applicable, Notices tabs. Update the original sheets, then download and upload fresh `.xlsx` files; the review workbook is a checklist, not an input file. Missing driver records produce collapsed notices and exclude that person from driver selection. Choose Yes in Drivers only when offering a car with five total seats. Historical records also require actual dates and reviewed identities.

### Online planning

The website uses TomTom. Uploads are validated locally; TomTom is contacted by **Plan week**, which prepares travel estimates and calculates the plan in one action. There is no demo or automatic hypothetical-copy workflow in the website. Resolve unknown attendance and missing pickup addresses in the source sheets and reupload before planning. A configured TomTom browser key is required. Past dates retain their calendar dates and use matching future weekdays for labeled traffic comparisons, which cannot be published as live schedules. The destination defaults to the user-supplied `300 Waterfront Dr, Pittsburgh, PA 15222`.

## Advanced canonical format v1

The following technical headers remain compatible in XLSX files and in the CSV-based legacy developer tools. They are not required in the simple member-facing sheets.

### members.csv

| Column                 | Required header | Meaning                                                                                                            |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------ |
| member_id              | Yes             | Unique, stable identity, not row number. Use the same ID across every input.                                       |
| display_name           | Yes             | Known display name; provisional labels must not invent a full name.                                                |
| pickup_address         | Yes             | Reviewed meeting point; may be blank in a draft. A pickup is not necessarily a home address.                       |
| pickup_lat, pickup_lng | No              | Both or neither. Finite latitude −90…90, longitude −180…180. Confirmed coordinates can be used without an address. |
| pickup_notes           | No              | Local notes.                                                                                                       |

A participating carpool member needs a pickup address, coordinates, or a `pickup_override` for that date. No pickup confirmation field is read or checked. Incomplete pickup data for nonparticipants does not block planning. Coordinates take precedence over the member address for routing. Blank/non-location/ambiguous legacy values remain draft review items; nothing is automatically geocoded during import.

### attendance.csv

| Column          | Required header | Meaning                                                                                               |
| --------------- | --------------- | ----------------------------------------------------------------------------------------------------- |
| date            | Yes             | Real `YYYY-MM-DD` calendar date. Select at most seven dates in the app.                               |
| member_id       | Yes             | Existing member ID.                                                                                   |
| attending       | Yes             | `true`, `false`, `unknown`; these are distinct strings.                                               |
| transport_mode  | Yes             | `carpool`, `self`, `external`, `uber`, `unknown`.                                                             |
| pickup_override | No              | A reviewed location for this person on this date; overrides the member's default coordinates/address. |
| ready_after     | No              | `HH:MM`, America/New_York. Defaults to the planning earliest-departure setting.                       |
| notes           | No              | Local notes.                                                                                          |

Missing rows mean not signed up in this input, not confirmed historical absence. Unknown attendance must be reviewed for selected dates; a true attendee with unknown transport also blocks a complete operational plan. Self/external attendees are shown separately. They consume no club-car seats and are not selectable drivers.

### driver_availability.csv

| Column             | Required header | Meaning                                                                                     |
| ------------------ | --------------- | ------------------------------------------------------------------------------------------- |
| date, member_id    | Yes             | Valid date and existing member ID.                                                          |
| available          | Yes             | `true`, `false`, `unknown`; missing rows mean unknown.                                      |
| total_seats        | Yes             | Integer 1–5, **including the driver**, whenever available is true. May be blank otherwise.  |
| source             | Yes             | `confirmed` or `simulated`. Any selected-date simulated input labels the result Simulation. |
| start_address      | No              | Driver start; defaults to their date-specific pickup location.                              |
| earliest_departure | No              | `HH:MM`, America/New_York; combined with driver readiness and global earliest departure.    |
| max_route_minutes  | No              | Positive number; the stricter of individual/global limits applies.                          |

Only explicitly available, attending carpool members can drive. An available driver not selected is still a passenger requiring a seat. Historical ownership is neither current availability nor an eligibility veto.

Duplicate members or duplicate person/date records are rejected even when the duplicate values are identical. Unknown cross-file IDs, malformed records, invalid enums/times/dates, partial coordinates and impossible capacities report affected rows. The application does not drop invalid rows to make a plan look complete.

## Outputs and safety

The result page shows assignments and expandable routes without bulk export controls or technical diagnostics. The retained export utilities are available internally and covered by unit tests. Their JSON format includes generation time, schema, Simulation/Google state, settings, optimizer seed, in-tab scenario configuration, status by day, driver counts/minutes, ordered stops, active member names, locations and navigation links. Matrices are not exported. CSV repeats metadata and gives separate rows for drivers, riders, destinations, self/external/unresolved/unassigned members. CSV exports neutralize spreadsheet-formula prefixes; canonical input generation preserves values and IDs.

Times are seconds after local midnight internally and formatted as New York wall times. Provider timestamps are explicit UTC instants derived from the selected New York date, with daylight-saving gaps rejected. No practice date is inferred from a workbook filename.

The MVP rejects a planning window that crosses a daylight-saving clock change. Use an earliest departure of 03:00 or later on that transition date; ordinary early-morning practice windows already satisfy this. This avoids incorrectly interpreting wall-clock differences as elapsed travel time.

Optional **Own travel** and **Uber** tabs in the Attendance workbook use the same Yes/No grid. Yes attendees in Own travel map to `self`; Yes attendees in Uber map to `uber`. Conflicting exceptions or exceptions for a person marked No in Attendance are rejected. Club-car capacity shortfalls automatically propose up-to-four-person Uber groups at one shared pickup, requiring a separate booking.
