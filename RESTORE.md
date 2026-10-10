# Notfall: Projekt wiederherstellen

Diese Anleitung beschreibt, was wo gesichert ist und wie alles wieder aufgebaut wird,
wenn etwas verloren geht: Worker gelöscht, Cloudflare-Konto neu, Repo weg, Speicher leer.

## Was liegt wo?

| Teil | Wo | Gesichert durch |
|---|---|---|
| Code (Worker, Skripte, Tool) | GitHub `harzpassage-dev/Inplayflux-calibration` | Git, jede Version bleibt erhalten |
| Signal-Exporte, Kalibrierung, Reports | GitHub, Ordner `data/`, `calibration/`, `reports/` | Git |
| **Kunden-Zugänge, Premium-Logs, Warteschlange** | Cloudflare KV `ACCESS_KV` | **Admin-Panel → Backup** (manuell) |
| Geheimnisse (Bot-Token, Passwort …) | Cloudflare, nur verschlüsselt | **nur bei dir**: Passwort-Manager |
| Telegram-Webhook | bei Telegram registriert | einmal neu setzen (unten) |
| Domain `moneybag-signals.com` | Cloudflare | Domain-Einstellungen |
| Bilanz-Seite und PDF | claude.ai Artifact | jederzeit aus den Daten neu erzeugbar |

## Regelmäßig tun

1. **Wöchentlich:**
   - `moneybag-signals.com/admin` öffnen, Passwort eingeben, unter **Backup** auf
     **„Backup herunterladen“** tippen.
   - Die Datei `moneybag_backup_JJJJ-MM-TT.json` in Dropbox oder iCloud ablegen.
   - Sie enthält alle Zugänge mit Ablaufdatum, die Premium-Logs und die Warteschlange.
2. **Einmalig:** Diese Werte im Passwort-Manager notieren. Cloudflare zeigt Geheimnisse
   nach dem Speichern nie wieder an.
   - `ADMIN_PASSWORD`
   - `TELEGRAM_BOT_TOKEN` (alternativ jederzeit über @BotFather → `/token` abrufbar)
   - `TELEGRAM_WEBHOOK_SECRET` (beliebiger Zufallstext, darf auch neu gewählt werden)
   - `PREMIUM_CHANNEL_ID`, `ADMIN_CHAT_ID` (Telegram-Chat-IDs, beginnen oft mit `-100…`)
3. **Code-Stand sichern:** Den Branch `claude/page-radar-signal-analysis-bdok65` in den
   Hauptbranch mergen (PR #1). Dann liegt der Live-Stand auch im Hauptbranch.

## Wiederherstellen

### Fall A: Nur Zugänge oder Logs sind weg (Worker läuft noch)

Im Admin-Panel unter **Backup** die letzte Backup-Datei auswählen und auf
**„Einspielen“** tippen. Gleichnamige Einträge werden überschrieben, nichts wird
gelöscht. Bereits abgelaufene Zugänge werden übersprungen.

### Fall B: Worker gelöscht oder neues Cloudflare-Konto

1. **KV-Speicher anlegen** (nur bei neuem Konto): Cloudflare → *Speicher & Datenbanken* →
   *KV* → Namespace anlegen. Die neue ID in `worker/wrangler.toml` bei `[[kv_namespaces]]`
   eintragen und committen. Die bisherige ID lautet `4adee62e97ef429cac51cc3019d48a18`.
2. **Worker anlegen und mit GitHub verbinden:** *Workers und Pages* → *Anwendung erstellen*
   → *Mit Git verbinden*.
   - Repository: `harzpassage-dev/Inplayflux-calibration`
   - Branch: der Hauptbranch, oder `claude/page-radar-signal-analysis-bdok65`
   - **Stammverzeichnis: `/worker`**
   - Build-Befehl: leer
   - Deploy-Befehl: `npx wrangler deploy`
   - Der Name kommt aus `wrangler.toml` (`moneybag-access`). Cron (jede Minute) und
     Protokolle sind dort schon eingestellt.
3. **Geheimnisse setzen:** Worker → *Einstellungen* → *Variablen und Geheimnisse* → die fünf
   Werte von oben jeweils als **Geheimnis** eintragen.
4. **Domain:** Worker → *Einstellungen* → *Domänen* → `moneybag-signals.com` hinzufügen.
5. **Telegram-Webhook neu setzen.** Im Browser öffnen (Platzhalter ersetzen):
   ```
   https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://moneybag-signals.com/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
   ```
   Prüfen mit `https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo`. Dort muss die URL
   stehen, und `last_error_message` darf nicht gesetzt sein. Der Bot muss Admin im
   Signal-Kanal und im Premium-Kanal sein.
6. **Daten zurückholen:** Admin-Panel → **Backup einspielen** mit der letzten Datei
   (siehe Fall A).
7. **Kontrolle:**
   - `moneybag-signals.com` zeigt ohne Link die Sperrseite.
   - Das Admin-Panel öffnet sich, und **„Alle Zugänge“** listet die Kunden.
   - Nach dem nächsten High-Confidence-Signal steht unter **Premium-Bestätigungen** ein
     Eintrag.

### Fall C: GitHub-Repo verloren

Jede lokale Kopie (`git clone`) enthält die komplette Historie. Falls keine Kopie mehr
existiert: Ein neues leeres Repo anlegen und eine Claude-Code-Session bitten, aus der
letzten Kopie, die noch irgendwo liegt, alles hineinzupushen. Als Vorbeugung lohnt es
sich, gelegentlich auf GitHub unter *Code → Download ZIP* eine Kopie in die Dropbox zu
legen.

## Was nicht gesichert werden muss

- **Statistik und Modelle:** Sie liegen in `calibration/` und lassen sich jederzeit mit
  `scripts/recalibrate.py`, `scripts/analyze_signals.py`,
  `scripts/goal_drivers.py` und `scripts/premium_report.py` aus den CSV-Exporten neu berechnen.
- **Live-Feed:** Er kommt jederzeit neu von InPlayFlux.
