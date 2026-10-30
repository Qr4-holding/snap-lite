# Job records export

Snap Lite keeps one record per job. **Settings → Export records** (owner only) downloads every job in a date range as CSV or JSON. The export is made *ready for Digital Waste Tracking*; it is a convenience for your own systems, not a statement that any job is compliant.

* CSV: UTF-8 with a byte-order mark (opens cleanly in Excel), comma separated, CRLF line ends, header row first. A cell that would start with `=`, `+`, `-`, `@` is prefixed with `'` so spreadsheets do not run it as a formula.
* JSON: `{ "format": "snaplite-job-records", "version": 1, "exported_at", "from", "to", "count", "records": [ ... ] }`, one object per job. The field names and their order match the CSV columns.
* Date range: `?from=YYYY-MM-DD&to=YYYY-MM-DD` on `/settings/export.csv` or `/settings/export.json` (UK dates, both optional). Jobs are included by their created date.
* Jobs whose photos and video were deleted stay in the export with `media_deleted: true`. Records are kept for at least two years.

## Fields

| field | meaning |
|---|---|
| `record_id` | job id in Snap Lite |
| `job_reference` | the job's short reference (also used in its share link) |
| `job_date` | date the job was created, UK time, `YYYY-MM-DD` |
| `job_type` | e.g. House clearance |
| `job_state` | draft, rendering, ready, approved, shared, failed |
| `collection_address_line1`, `collection_town_or_area`, `collection_postcode` | where the waste was collected |
| `customer_name`, `customer_address` | customer (address on one line, comma separated) |
| `customer_is_business` | true for a commercial customer |
| `customer_business_name`, `customer_sic_code` | business name and 5-digit SIC code (commercial only) |
| `waste_description` | description of the waste |
| `ewc_code` | European Waste Catalogue code, e.g. `20 03 07` |
| `quantity` | `quarter`, `half`, `three_quarter`, `full`, `more` (empty if not set) |
| `quantity_label` | e.g. Half load |
| `quantity_cubic_yards` | quantity times the van capacity (empty for `more`) |
| `quantity_source` | `owner` if set by hand, `estimate` if read from the photos |
| `van_capacity_cubic_yards` | van capacity from Settings |
| `items` | items seen: JSON gives a list of `{item, count, material}`; CSV gives `item xN [material]; ...` |
| `flag_upholstered_seating_pops`, `flag_fridge_freezer`, `flag_plasterboard`, `flag_gas_bottles`, `flag_tyres`, `flag_suspected_asbestos` | true/false |
| `vehicle_registration` | van plate |
| `disposal_site_name`, `disposal_site_address`, `disposal_site_licence_number` | where it went |
| `disposal_date`, `disposal_ticket_number` | from the tip receipt |
| `tip_receipt_kept` | true if a receipt photo is stored |
| `carrier_name`, `carrier_registration_number`, `carrier_registration_tier` | the carrier, from the Environment Agency register |
| `driver_name` | the person who made the job |
| `media_deleted`, `media_deleted_at` | photos and video were deleted (record kept) |
| `record_created_at` | ISO timestamp |

Not included: invoices, scheduling or customer messages. Those belong in your office system.

## Transfer note

`GET /jobs/<id>/transfer-note.pdf` (owner only) returns the waste transfer note as an A4 PDF laid out like the carrier's own note.
