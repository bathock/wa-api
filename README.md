# WA Gateway Baileys

Menggunakan `@whiskeysockets/baileys` **7.0.0-rc13**. Membutuhkan Node.js **20 atau lebih baru**.

## MariaDB auth storage

Gateway tidak memakai folder `sessions/`. Semua credentials dan Signal keys disimpan ke MariaDB. Tabel `wa_auth_sessions` dan `wa_auth_keys` dibuat otomatis saat startup.

Buat database dan user sekali saja:

```sql
CREATE DATABASE wa_gateway CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'wa_gateway'@'127.0.0.1' IDENTIFIED BY 'ganti_password_kuat';
GRANT ALL PRIVILEGES ON wa_gateway.* TO 'wa_gateway'@'127.0.0.1';
FLUSH PRIVILEGES;
```

## Install
```bash
npm ci
cp .env.example .env
# isi DB_PASSWORD
npm start
```

## Endpoint

### Buat / konek session
```http
POST /api/whatsapp/session/create
Content-Type: application/json

{ "sessionId": "admin" }
```

### Ambil QR
```http
GET /api/whatsapp/session/admin/qr
```

### Info session
```http
GET /api/whatsapp/session/admin/info
```
Output berisi `output`, `nomor`, `nama`, `foto`, status koneksi, limit pesan, status WhatsApp Business, dan status restriction/reachout timelock.

Contoh saat akun sedang dibatasi:

```json
{
  "output": "restricted",
  "connected": true,
  "restricted": true,
  "restrictionCode": 463,
  "restrictionType": "reachout_timelock",
  "restrictionReason": "Reachout timelock: DEFAULT",
  "restrictionEndsAt": "2026-07-06T10:30:00.000Z",
  "reachoutTimeLock": {
    "active": true,
    "enforcementType": "DEFAULT",
    "endsAt": "2026-07-06T10:30:00.000Z"
  }
}
```

### Kirim pesan
```http
POST /api/whatsapp/session/admin/send-message
Content-Type: application/json

{
  "number": "08123456789",
  "message": "Halo",
  "messageId": "INV-001"
}
```

### Kirim file URL/localhost/local path
```http
POST /api/whatsapp/session/admin/send-file
Content-Type: application/json

{
  "number": "08123456789",
  "fileUrl": "http://localhost/nota.pdf",
  "caption": "Nota pembayaran",
  "messageId": "NOTA-001"
}
```

`fileUrl` bisa `http/https`, `file:///path/file.pdf`, atau path lokal `/var/www/html/nota.pdf`.

## ENV penting
```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=wa_gateway
DB_PASSWORD=ganti_password_kuat
DB_NAME=wa_gateway
DB_CONNECTION_LIMIT=10

MAX_SESSIONS=5
MESSAGE_LIMIT_PER_HOUR=120
WEBHOOK_ENABLED=false
WEBHOOK_URL=
TYPING_MIN_SECONDS=3
TYPING_MAX_SECONDS=8
AUTO_RESTORE_SESSIONS=true
```

## LID, kontak, dan webhook

Field `number` tetap dipakai untuk kompatibilitas, tetapi sekarang menerima nomor telepon atau LID langsung.

```json
{
  "number": "123456789012345@lid",
  "message": "Halo via LID"
}
```

Nomor telepon divalidasi melalui `onWhatsApp()`. LID tidak dikirim ke `onWhatsApp()` dan tidak dianggap invalid hanya karena tidak memiliki mapping nomor. Bila mapping tersedia dari event kontak/pesan, response menyertakan `lid`, `phoneJid`, `number`, `destinationType`, dan `validation`.

Webhook `message.received` hanya dikirim untuk pesan nyata menurut `isRealMessage()`. Payload juga menyertakan identitas lengkap:

```json
{
  "sessionId": "admin",
  "identity": {
    "jid": "123456789012345@lid",
    "altJid": "628123456789@s.whatsapp.net",
    "participant": null,
    "participantAlt": null,
    "addressingMode": "lid",
    "messageId": "...",
    "serverId": null,
    "fromMe": false,
    "lid": "123456789012345@lid",
    "phoneJid": "628123456789@s.whatsapp.net",
    "number": "628123456789"
  },
  "contact": null,
  "message": {}
}
```

Cache kontak dan mapping LID ↔ phone JID memakai TTL 5 menit. Session info sekarang juga menyertakan `platform` dan `isBusiness`.

## Restriction / Reachout Timelock

Gateway menangani restriction melalui dua jalur:

1. Native Baileys v7 `connection.update.reachoutTimeLock` dan `fetchAccountReachoutTimelock()`.
2. Fallback error server `463` / `ACCOUNT_RESTRICTED_TEXT`.

Saat native timelock aktif, `send-message` dan `send-file` langsung ditolak dengan HTTP `403` tanpa mencoba mengirim ke server:

```json
{
  "success": false,
  "error": "REACHOUT_TIMELOCK",
  "restricted": true,
  "restrictionCode": 463,
  "restrictionType": "reachout_timelock",
  "restrictionEndsAt": "2026-07-06T10:30:00.000Z"
}
```

Webhook status:

```text
session.reachout_timelock
session.restricted
```

Auth database **tidak dihapus** saat restriction. Data auth hanya dihapus untuk logout, bad session, atau saat endpoint delete session dipanggil. Timelock otomatis dibersihkan saat WhatsApp mengirim status `isActive: false` atau waktu restriction telah berakhir.

Custom MariaDB auth state menyimpan semua key Baileys v7, termasuk `lid-mapping`, `device-list`, dan `tctoken`. Event `lid-mapping.update` dipakai untuk memperbarui cache PN ↔ LID gateway.

