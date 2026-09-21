# ESP32 BLE gateway

Listens for the BLE tags registered to students and reports which ones it hears,
and how strongly, to the backend. It never decides who is present: the backend
combines these sightings with the camera's face matches and applies the
thresholds. See `docs/SMART_ATTENDANCE.md` for the whole system.

## What you need

- An ESP32 board, powered near the door (USB power is fine).
- Arduino IDE with the **ESP32 board package**.
- The **ArduinoJson** library by Benoit Blanchon, v7.x (Library Manager).
- A BLE tag per child that advertises a fixed address (a beacon or tracker tag,
  not a phone — phones change their address for privacy).

The sketch uses the same BLE calls as the original `CAPSTONE.ino` (arduino-esp32
2.x API). It has been compile-checked against host stubs, **not** flashed to a
board; if you use core 3.x and the build complains about the BLE callbacks,
that is where to look.

## 1. Find your tags' addresses and measure signal strength

Set `#define SCAN_ONLY 1` at the top of `esp32-ble-gateway.ino` and flash. It needs
no Wi-Fi or server and prints everything it hears, strongest first:

```
--- 7 device(s) ---
D7:40:47:15:14:90   -52 dBm  MyTag
...
```

- Hold a tag next to the board to find its address; register that address on the
  student's page in the app (**Attendance tag**).
- Measure calibration numbers with the board **where it will be mounted**: note
  the RSSI with a tag at 0.5 m, 1 m, 2 m, and at the doorway, several readings each
  (it fluctuates by 10 dB or more). Choose the backend's `BLE_MIN_RSSI` so
  "at the door" passes and "down the hall" does not. The old sketch's `-30` means
  "touching the board" — far stricter than you likely want.

## 2. Configure

```bash
cp secrets.example.h secrets.h    # secrets.h is git-ignored: never commit it
```

Fill in `secrets.h`:

| Setting | Value |
| --- | --- |
| `WIFI_SSID` / `WIFI_PASSWORD` | the school's 2.4 GHz network (ESP32 has no 5 GHz) |
| `API_BASE_URL` | `https://your-backend-host` — HTTPS only; the firmware halts on `http://` |
| `DEVICE_KEY` | printed once by `npm run gateway:create -- "Front door"` in the backend |
| `ROOT_CA_PEM` | the root certificate that signed the backend's TLS certificate |

Getting the root certificate: `openssl s_client -showcerts -connect HOST:443 </dev/null`
and paste the **last** certificate shown (or download your CA's root). The gateway
verifies the server against it, so a fake server on the school network can't
collect the key. There is deliberately no "skip verification" option.

## 3. Flash with `SCAN_ONLY 0`

Open the Serial Monitor at 115200 baud. Expected:

```
Wi-Fi connected, IP 192.168.x.x
Listening for 30 tag(s).
Attendance started: scanning.      <- when a teacher presses Start Attendance
Attendance stopped: idle.
```

While no session is running the gateway only checks in every 5 s; it scans only
during a session.

## Troubleshooting

| Serial output | Meaning |
| --- | --- |
| `Backend rejected the device key (401)` | wrong or disabled `DEVICE_KEY` (or copied with a stray space) |
| `Request failed (-1)` right after Wi-Fi connects | TLS failed: wrong `ROOT_CA_PEM`, or the clock isn't synced |
| `Clock not synced yet` | NTP blocked on the network; certificates can't be checked without the date |
| `Rate limited (429)` | too many requests; it slows itself down automatically |
| `Listening for 0 tag(s)` | no tags registered yet, or all paused |

The app's live screen shows **Door tag reader: Online / Not connected**.

## Security notes

- Only tag addresses go **to** the device; it never learns student names or ids.
- The device key is a random 256-bit secret; the server stores only its hash.
- If a board is lost, disable its row in `ble_gateways` (`enabled = false`) and create a new gateway.
