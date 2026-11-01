# Sarvam Reminders

A voice-first reminder page for bills, medicines and payments. Speak or type a reminder in Hindi, Tamil, Telugu and other Indian languages; the page understands it, saves it, and speaks it back when it is due.

## Use it

Open the page, paste your own Sarvam API key (stored only in this browser), and start speaking.

## How it works

- Speech to text: Sarvam Saaras v3
- Understanding the reminder (title, date, repeat): Sarvam chat model with JSON output
- Spoken reminders: Sarvam Bulbul v3

No server; the page is static HTML and calls the Sarvam API directly from the browser.

## Note

Reminders fire only while the page is open. Use Download backup to move reminders to another device.
