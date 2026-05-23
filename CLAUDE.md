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
- Import von Verlaufsdaten
    - CSV import Standard ist das Export format
    - passen die Spalten namen nicht überein oder das Format muss ein Mapper gemacht werden vom user
    - Wenn aus dem Import Daten für Tage im Storage bereits vorliegen, wird der User gewarnt. Er kann auswählen: Daten von Tagen die im local storage vorhanden sind dann überschreiben oder die Daten aus dem lokal storage behalten und nur die daten aus dem import nutzen die im local storage nicht vorhanden sind

-Der Verlaufseintrag ist noch nicht richtig von der Breite die anderen schon, achte aufs responsive design
-Tausche Morgen und Abend Tab in der Reihenfolge der UI
-Nutze Falls möglich statt emojis auf den Buttons und im Interface coole Icons die Vom design her passen
