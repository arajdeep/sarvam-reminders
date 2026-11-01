# Sarvam Reminders

Voice-first reminders for medicines, meals, bills and appointments, in Indian languages. Built for people in small towns who find typed, English-only apps hard to use, and for the families and care homes that look after them.

## The problem
Someone living alone in a tier-3 town has medicines to take before or after food, bills to pay on time, and family far away who worry. Existing reminder apps assume typing, English, and one user.

## MVP (what works today)
- **Pick your language first**, shown in its own script: English, हिन्दी, বাংলা, मराठी, தமிழ், తెలుగు, ગુજરાતી, ಕನ್ನಡ, മലയാളം, ਪੰਜਾਬੀ, ଓଡ଼ିଆ. English and Hindi are written by hand; the others are translated by Sarvam once and cached on the device.
- **Then pick who it's for:** just me, my family, me and my partner, or a care home.
- **Speak or type** a reminder in your language ("roz subah 8 baje BP ki goli khane ke baad"). Sarvam understands it and fills the form; you confirm.
- **Food timing:** before food alerts 30 min early, after food 20 min late.
- **Spoken alerts** in the reminder's language, plus browser notifications.
- **Dose tracking:** Lo liya / 10 min baad / Chhoot gaya. A dose is marked missed 60 min after its time.
- **"Sab theek hai?"** daily check-in: theek hoon / thoda theek nahi / madad chahiye.
- **Streaks** for taking all medicines on time.
- **Spoken daily summary** of what's left today.
- **Quick-add templates** per profile (baby, child, adult, elder). No API call needed.
- **Backup and restore** as a file.

## Modes
| Mode | Who | What's different |
|---|---|---|
| Solo | Someone living alone | Their own reminders and check-in |
| Family | Babies, children, elders and the caregivers who help them | Caregivers set reminders for any member; alerts for missed doses, silent check-ins and "madad chahiye", shareable on WhatsApp; daily board |
| Couples | Two partners | Each sees the other's doses and bills |
| Care home | Daycares and old-age homes | Residents and staff; a board with every resident's progress and check-in |

## Sarvam APIs used
- **Saaras v3** speech-to-text (code-mixed speech)
- **sarvam-105b** chat with JSON output, validated in code before saving (reminder understanding and interface translation)
- **Bulbul v3** text-to-speech for alerts and the daily summary

## Run it
Open `index.html` from any static host (Vercel, GitHub Pages) and paste your own Sarvam API key. The key stays in that browser; this repo contains no key.

## Tests
```
node --test tests/logic.test.js
```
13 tests cover parsing safety, food timing, missed doses, streaks, bills, and family and care-home alerts.

## Limits of this proof of concept
- Data lives in one browser. Family, couples and care-home members share one screen; syncing across phones needs a backend.
- Alerts fire only while the page is open.

## Direction
1. Backend sync with a group code, so each family member or staff member uses their own phone.
2. Push notifications that ring when the page is closed.
3. Phone-call reminders through Sarvam voice agents, for elders without smartphones.
4. Prescription photo to schedule, with Sarvam Vision.
