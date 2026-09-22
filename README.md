# ECCD-Backend
Backend repository for ECCD SmartTrack System

## Smart attendance (face recognition + BLE)

Students are marked present automatically when both their face (camera) and their
BLE tag (ESP32) are seen at the door. Setup, calibration and operating notes:
[`docs/SMART_ATTENDANCE.md`](docs/SMART_ATTENDANCE.md). Components:
[`face-recognition-service/`](face-recognition-service/) and
[`esp32-ble-gateway/`](esp32-ble-gateway/).
