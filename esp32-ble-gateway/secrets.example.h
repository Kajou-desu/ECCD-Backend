// Copy this file to secrets.h (which is git-ignored) and fill in your values.
// NEVER commit secrets.h: it holds the Wi-Fi password and the gateway's key.
#pragma once

#define WIFI_SSID "<YOUR_WIFI_NAME>"
#define WIFI_PASSWORD "<YOUR_WIFI_PASSWORD>"

// The backend, HTTPS only, no trailing slash. The firmware refuses to run with
// http:// because the device key would travel in clear text.
#define API_BASE_URL "https://<YOUR_BACKEND_HOST>"

// Printed once by:  npm run gateway:create -- "Front door"   (in ECCD-Backend)
// Looks like "3.<64 hex characters>". Lost it? Disable the gateway and create a new one.
#define DEVICE_KEY "<YOUR_DEVICE_KEY>"

// The ROOT certificate that signed your backend's TLS certificate, in PEM form.
// The gateway checks the server against this, so a fake server on the school
// network can't steal the key. Get the chain with:
//   openssl s_client -showcerts -connect <YOUR_BACKEND_HOST>:443 </dev/null
// and paste the LAST certificate shown (the root), or download your CA's root.
static const char ROOT_CA_PEM[] = R"PEM(
-----BEGIN CERTIFICATE-----
<PASTE_ROOT_CA_CERTIFICATE_HERE>
-----END CERTIFICATE-----
)PEM";
