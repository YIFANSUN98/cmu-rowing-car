# CMU Rowing Carpool — initial release v0.1.0

Website: https://cmu-rowing.pages.dev/

## Files in this local release kit

- `empty-templates/`: three empty Excel workbooks, ready to fill in.
- `week3-examples/`: three populated workbooks based on the private Google Drive Week 3 sheets. Only the visible input tables are included.
- `source-exports/`: original Google Drive downloads, including their hidden archive tabs.
- `source-manifest.json`: source links, headers, row counts and validation totals.
- `validation-details.json`: any input review findings. Keep this kit private: the populated files contain real member information.

Each input set has `members.xlsx`, `attendance.xlsx` and `drivers.xlsx`. Upload one complete set at a time. Empty templates deliberately contain headers only; they cannot generate a plan until filled in. Their date headers match the Week 3 examples, **October 20–24, 2026**. Replace these dates in both grids when preparing a different week.

The Week 3 examples preserve source values. Confirm actual practice dates, attendance, pickup addresses and current driver availability before using them for a live schedule. Historical driver answers were derived from car arrangements and need confirmation. Passing file validation does not confirm that these records are current.

## Prepare your three Excel files

1. In **Members**, fill `Name` and `Pickup address`. Use a full, usable pickup address for each person.
2. In **Attendance**, keep `Name` in column A and practice dates across row 1 as `YYYY-MM-DD`. Put Yes or No under each date for every person.
3. In **Drivers**, use the same names and dates. Yes means that person can drive that day. The planner assumes five total seats, including the driver; actual seats can be adjusted in the route editor.
4. Use identical names across all three files. Keep the tab names **Members**, **Attendance** and **Drivers**, with headers in row 1 and no merged input cells. Save as `.xlsx`.

Blank attendance and driver answers are treated as No. Check them deliberately. For an attendee arranging their own trip, add an optional **Own travel** Yes/No grid to the attendance workbook. An optional **Uber** grid records requested Uber trips. Keep these people Yes in Attendance. Do not mark both exceptions for the same person and date.

To update the private Google Sheets instead, edit them in Drive, then choose **File → Download → Microsoft Excel (.xlsx)** for each one. The website reads your downloaded files; it does not update the source Sheets.

## Admin: prepare and publish a week

1. Open the website and sign in with the admin access key provided separately.
2. Choose **Choose Excel files** and select all three workbooks together, or drag and drop them. Files must be `.xlsx`, at most 5 MB each. Missing tables and review findings appear in the upload area.
3. Correct any blocking findings in Excel and upload the corrected file. You can replace just one file while keeping the other two loaded.
4. Confirm the destination and arrival time. Times are Eastern Time. Choose **Plan week**. Planning uses TomTom road estimates and privately saves the input files.
5. Review each date, driver, passengers, pickup order and timing. Choose **Show route** on a car to expand its route. Use **Download Excel** for the plan workbook.
6. If needed, choose **Edit routes**. Adjust cars, drivers, seats, travel choices, pickup order or departure times, then choose **Generate updated plan** and review again. **Arrange manually** starts an arrangement directly from the loaded files.
7. Choose **Publish to team** or **Update published plan** when the reviewed schedule is ready. This shares the routes with team members. Past-date comparisons cannot be published as live schedules.

Uber groups require a separate booking. The app does not book rides. Confirm real-world capacity and arrangements before publishing.

## Return to an existing plan

Open **Private Excel files · admin only**, then **Load saved files** to restore inputs. To revise the shared schedule, choose **Edit published routes**, make changes, generate updated routes and publish the revision. Edits stay in the current browser tab until you publish; they do not change your Excel files or Google Sheets. **Replan from files** replaces manual changes using the uploaded inputs.

## Team: view the schedule

Sign in using the team access key supplied separately. Select the practice date, find your car and review pickup information. **Show route** expands the route; the navigation link opens Google Maps. Team access permits viewing published routes and does not expose the private input files or editing controls.

## If something needs attention

- Missing input: upload the missing workbook, keeping the expected tab name and headers.
- Name mismatch: use the same spelling in all three files.
- Missing pickup or unavailable driver: confirm the information and correct the input or manual arrangement.
- Routing failure: check the address and connection, then retry. The app requires live routing to generate routes.
- Edited a file after planning: upload it and generate a fresh plan before publishing.
- Slow page loading: reload once and check the connection. Planning a new week makes live road-routing requests and can take longer than opening an already published plan.

Release preparation keeps the current published team schedule in place. Deploying the website is separate from publishing a new carpool plan.
