# 🌬️ AirWise — Urban Air Quality Assistant

**PromptWars Virtual · Challenge 06**

AirWise turns **live air-quality data** into a **personalised clean-air day** for your family. It covers low-emission routines, indoor air hacks and sustainable swaps, and it **quantifies the direct impact of every choice**.

## The problem
In winter smog, checking an AQI app every ten minutes doesn't tell a family *what to do*. People need to know when to step out, which room to keep sealed, whether the kids can play outside, and how much each change actually helps.

## How it works

```
Browser (accessible vanilla JS)
   │  location + lifestyle profile
   ▼
Express API (Cloud Run)
   ├─ Air quality ─► Google Air Quality API  (fallback: Open-Meteo / CAMS)
   ├─ Impact engine ─► deterministic maths: inhaled PM2.5 dose, CO₂ & PM avoided
   └─ Gemini ─► structured JSON plan, grounded in the live data + impact numbers
                (falls back to a rule-based plan, so the app always works)
```

### Key design decisions
| Concern | Approach |
|---|---|
| **No hallucinated numbers** | Impact figures are computed in code (`src/impact.js`). Gemini is told to cite only these numbers. |
| **Reliable output** | Gemini `responseSchema` structured JSON, validated server-side before rendering. |
| **Always functional** | Automatic Gemini model failover with backoff when a model is overloaded (503/429) or times out, then a rule-based plan as the last resort. Open-Meteo fallback for AQ data. |
| **Security** | API keys stay server-side (sent as headers, not in URLs). Helmet with a strict CSP. Rate limiting, 10 kb body cap, whitelist validation of every field, prompt-injection fencing for user questions, and no `innerHTML` (model output rendered as text only). Errors never leak stack traces. Non-root container. |
| **Efficiency** | ~1 km coordinate-rounded TTL cache for AQ (10 min) and geocoding (24 h). Only 3 runtime dependencies. No frontend framework or build step. |
| **Accessibility** | Semantic landmarks, skip link, labelled controls, ARIA combobox with keyboard navigation, `aria-live` results, AQI shown as text and not by colour alone, 44 px touch targets, dark mode, `prefers-reduced-motion`. Hindi output option. |

## Features
- 📍 City search or browser geolocation
- 🟠 Live AQI, pollutant breakdown, 24-hour forecast bars and the **cleanest upcoming hours**
- ⏱️ Timed low-exposure daily routine
- 📊 **Impact cards** with figures such as "N95 on commute → 864 µg less PM2.5/day (90%)" and "Petrol car → metro → 61.6 kg CO₂/month avoided"
- 🏠 Indoor air hacks with cost tags · 🌱 sustainable swaps
- ⚠️ Health alerts tailored to children, elderly, asthma, heart conditions and pregnancy
- 💬 "Ask AirWise" grounded follow-up Q&A
- 🇮🇳 English / Hindi

## Run locally
```bash
npm install
cp .env.example .env   # add GEMINI_API_KEY (https://aistudio.google.com/apikey)
export $(cat .env | xargs) && npm start
# open http://localhost:8080
```
It works without any key too, using rule-based plans and Open-Meteo data.

## Test
```bash
npm test     # 40 tests: unit + API integration (all upstream calls mocked)
```

## Deploy to Google Cloud Run
```bash
gcloud run deploy airwise \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-env-vars GEMINI_API_KEY=YOUR_KEY,GEMINI_MODEL=gemini-flash-latest
# optional: add GOOGLE_MAPS_API_KEY=... with the Air Quality API enabled
```
For production, store keys in **Secret Manager** (`--set-secrets GEMINI_API_KEY=gemini-key:latest`).

## Impact methodology (sources)
- Inhaled dose = PM2.5 (µg/m³) × breathing rate (m³/h) × hours × (1 − mask efficiency). Breathing rates come from the US EPA *Exposure Factors Handbook* (rest 0.4, light 1.0, vigorous 3.2 m³/h).
- Indoor/outdoor PM2.5 ratios: about 0.9 with windows open and about 0.25 with windows closed plus a HEPA purifier.
- Emission factors (kg CO₂e per passenger-km) are approximate urban averages, for example petrol car 0.17, metro 0.03 and bus 0.05.

All figures are estimates meant to help people compare options. They are not medical advice.

## Project structure
```
src/
  app.js        Express app, routes, security middleware
  aqi.js        Google AQ / Open-Meteo client + AQI bands + cleanest windows
  impact.js     Deterministic impact engine
  gemini.js     Prompting, structured output, fallback plan
  validate.js   Input validation
  cache.js      TTL cache
public/         Accessible frontend (HTML/CSS/JS, no build step)
test/           node:test unit + integration tests
Dockerfile      Cloud Run image
```
