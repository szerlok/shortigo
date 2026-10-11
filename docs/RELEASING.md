# Wydania Shortigo

Repozytorium publikuje obecnie kod źródłowy. Gotowe instalatory nie są wymagane do uruchomienia przez `npm run dev`.

## Lokalna paczka macOS

Na Macu o docelowej architekturze przygotuj komplet narzędzi:

```bash
bash scripts/prepare-resources.sh arm64 # x64 na Macu Intel
npm run dist:mac
```

Skrypt pobiera i weryfikuje Python, instaluje przypięte zależności oraz buduje FFmpeg z obsługą napisów i dołącza licencje. Wymaga narzędzi deweloperskich macOS i zależności opisanych w skrypcie. Domyślnie notaryzacja jest wyłączona; bez własnego Developer ID paczka nie jest wydaniem podpisanym do dystrybucji.

## Podpisane wydania na GitHub

Workflow `Release` pozostaje wyłączony, dopóki zmienna repozytorium `ENABLE_SIGNED_RELEASES` nie ma wartości `true`. Przed włączeniem skonfiguruj własne środowisko `release`, wymaganych recenzentów i sekrety:

- `APPLE_CERTIFICATE` (certyfikat Developer ID w formacie p12, base64),
- `APPLE_CERTIFICATE_PASSWORD`,
- `APPLE_ID`, `APPLE_PASSWORD` (hasło aplikacji), `APPLE_TEAM_ID`.

Nie używaj tożsamości ani certyfikatów autorów BridgeClip. Workflow sprawdza podpis względem skonfigurowanego Team ID i włącza notaryzację dla wydania.

Wersja w `package.json` i `package-lock.json` musi odpowiadać tagowi `vX.Y.Z`. Workflow buduje z jednego, ustalonego commita, weryfikuje tag i publikuje wyłącznie szkic wydania. Przed publikacją sprawdź paczki na czystych komputerach obu architektur, licencje, sumy kontrolne i aktualizator.

Kanał aktualizacji wskazuje `szerlok/shortigo`. Nie publikuj plików `latest-mac.yml` bez odpowiadających im sprawdzonych paczek. Windows i Linux wymagają osobnej weryfikacji przed udostępnieniem instalatorów.
