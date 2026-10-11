# Gate device API

For installers and makers of gates, turnstiles and handheld readers that check SummitOps tickets and RFID cards.

A device asks SummitOps about each tap or scan and gets a yes or no. It also keeps a list of today's good tickets and cards, so it can decide on its own when the network drops, and sends those offline scans later.

Base URL: `https://<your SummitOps address>/api/v1/device`. Requests and answers are JSON. All times are UTC (ISO 8601).

## 1. Pair the device

A manager adds the device in SummitOps (Gate, Devices, Add a device) and gets a pairing code such as `K7QM-3XRP`. The code works once and expires after 30 minutes.

```
POST /api/v1/device/pair
{ "code": "K7QM-3XRP" }

200 { "token": "<device key>", "device": { "id": 12, "name": "Summit Quad gate 1", "location": "Summit Quad", "kind": "turnstile" } }
401 the code is wrong, used or expired
```

Store the key securely on the device. Send it on every other request:

```
Authorization: Device <device key>
```

A manager can switch a device off, remove it, or issue a new code. From then on, the old key gets `401` with `details.code = "device_unpaired"`. If the mountain switches off its Gate app, requests get `403`.

## 2. Check a tap online

```
POST /api/v1/device/check
{ "uid": "04A23B4C5D6E70", "client_ref": "gate1-000123" }
or
{ "code": "9F2C0A7E31B04D58A6C1", "client_ref": "gate1-000124" }
```

- `uid`: the chip serial (UID) as the reader gives it: hex with or without separators (`04:A2:3B:..`), or a decimal number. Both byte orders are tried for each form.
- `code`: a barcode or QR code read from a ticket.
- `client_ref` (strongly advised): your own unique id for this scan, up to 64 characters. If the same `client_ref` is sent again (a timeout and retry), you get the same yes or no back with `"repeat": true`, and the same fields (the open time, and rides left as they stand now). The scan is not counted twice, and a punch card loses only one ride.
- If a check times out and you decide offline instead, keep the same `client_ref` for that scan when you upload it (section 4). If the server did receive the check, the upload is then recognised as the same scan and no second ride is taken.

```
200 {
  "allow": true,
  "result": "ok",
  "message": "Welcome, Maya",
  "open_ms": 3000,
  "uses_remaining": 4,      // punch cards; null for unlimited
  "valid_to": "2027-03-09"
}
```

Open the gate only when `allow` is `true`, for `open_ms` milliseconds. Show `message` on the device's display if it has one. `result` is one of:

| result | meaning |
| --- | --- |
| `ok` | valid: let them through |
| `duplicate` | the same ticket went through moments ago (the pass-back hold) |
| `expired` / `not_yet_valid` | outside its dates |
| `no_uses` | punch card with no rides left |
| `void` | refunded or voided |
| `card_blocked` | the card was reported lost |
| `unknown` | no ticket or card with that code or chip |

Every check is logged with the device's location.

## 3. Keep the offline list

Fetch the list at start-up and every few minutes:

```
GET /api/v1/device/list

200 {
  "date": "2026-12-19",            // the mountain's local date the list is for
  "passback_seconds": 120,
  "code_hash": { "alg": "HMAC-SHA256", "key": "<today's key>", "hex_chars": 32, "input": "the ticket code in uppercase" },
  "items": [ { "code_hash": "5b1f...", "uid": "04A23B4C5D6E70", "uses_remaining": null }, ... ],
  "blocked": [ "0A0B0C0D", ... ]
}
```

Ticket codes are not sent, because a code works as a ticket. Each item has a `code_hash`: the first 32 hex characters of HMAC-SHA256 of the uppercase ticket code, using today's `key`. To check a barcode offline, hash it the same way and look for the result. Chip serials (`uid`) are sent as they are, in uppercase hex.

Send `If-None-Match` with the `ETag` from the last list. While nothing has changed you get `304 Not Modified` and no body, so fetching every few minutes costs little.

When SummitOps cannot be reached, decide on the device:

- allow a chip in `items` (match its serial in either byte order), or a barcode whose hash is in `items`;
- refuse anything in `blocked`, or not in the list;
- hold the same chip or code for `passback_seconds`;
- for punch cards (`uses_remaining` not null), count rides down locally;
- stop using a list whose `date` is not today.

The list contains no names, photos or contact details.

## 4. Send offline scans

When the network is back, send what the device decided on its own, oldest first, up to 500 at a time:

```
POST /api/v1/device/scans
{ "scans": [
  { "client_ref": "gate1-000125", "at": "2026-12-19T14:07:31Z", "uid": "04A23B4C5D6E70", "allowed": true },
  { "client_ref": "gate1-000126", "at": "2026-12-19T14:07:40Z", "code": "77AA...", "allowed": false }
] }

200 { "saved": 2, "repeats": 0, "rejected": [] }
```

Each scan is saved once, by `client_ref`, so sending the same batch again is safe (`repeats` counts those). An allowed scan on a punch card uses one ride. The device's decision stands: this is the record of what happened.

A scan dated more than 5 minutes in the future, or more than 14 days ago, is not saved. It comes back in `rejected` with its `client_ref`, so a device with a wrong clock can be spotted. Keep the device's clock set by NTP.

## 5. Health

```
GET /api/v1/device/ping   ->  200 { "ok": true, "device_id": 12, "server_time": "..." }
```

The manager's Devices screen shows each device's last contact, its last list download, and its scans in the past 24 hours.

## Limits and good practice

- The pairing endpoint allows 10 tries per 10 minutes per address. Other device endpoints allow 600 requests a minute per address. All the gates at a mountain usually share one internet address, so tell SummitOps if your busiest minute might go past that.
- Use HTTPS only. Keep a check's timeout short (about 1.5 s), then fall back to the offline list so the line keeps moving.
- Reader settings: either output form of the UID works. If you can choose, use uppercase hex without separators.
- Barcode scanners and desk RFID readers plugged into a counter computer need none of this. They type into the Gate screen like a keyboard.
