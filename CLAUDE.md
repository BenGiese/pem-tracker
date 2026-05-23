# PEM-Tracker

App zur PEM-Vorhersage für ME/CFS-Patienten. Entwickelt für meine Mutter.

## Stack
- Vite + React (JSX, kein TypeScript)
- Keine externen UI-Libraries — alles inline styles
- PWA via vite-plugin-pwa (Ziel: Android Homescreen-App)
- Daten: localStorage, kein Backend

## Architektur
- Einzel-Datei-Komponente (App.jsx) — bewusst so gehalten
- computeBaseRisk: Tages-Score ohne Rolling Context
- computeDayRisk: Vollscore mit Rolling Context (N Vortage)
- 3-Block-Korrelationsanalyse: Same-Day / Prodromal / Trigger-Lag

## Nächste Schritte
- CSV-Export als echter Download 
- Service Worker + Offline-Fähigkeit
- Push-Benachrichtigungen zur Erinnerung