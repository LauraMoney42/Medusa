# App Store Visual Assets Package

Packaged by Dev4. Ready for upload to App Store Connect (ASC) and Google Play.

## Package file

`Medusa/assets/app-store-visual-assets.zip` (2.1 MB)

Extracted structure:

```
app-store-upload/
├── TheNarrator/
│   ├── icon-1024x1024.png
│   └── ios-screenshots/
│       ├── 01-home.png
│       ├── 02-library.png
│       ├── 03-settings.png
│       ├── 04-ocr.png
│       └── 05-subscriptions.png
└── Quizzik/
│   ├── icon-1024x1024.png
│   ├── ios-screenshots/
│   │   ├── 01-home.png
│   │   ├── 02-settings.png
│   │   ├── 03-library.png
│   │   ├── 04-flashcards.png
│   │   ├── 05-quiz.png
│   │   └── 06-import.png
│   └── android-screenshots/
│       ├── 01-home.png
│       ├── 02-settings.png
│       ├── 03-library.png
│       ├── 04-flashcards.png
│       ├── 05-quiz.png
│       └── 06-import.png
```

## App Store Connect records

| App | ASC App ID | Bundle ID | Icon | iPhone screenshots |
|-----|------------|-----------|------|-------------------|
| The Narrator | `6780281887` | `us.kindcode.narrator` | `TheNarrator/icon-1024x1024.png` | 5 × 1320×2868 RGB |
| Quizzik | `6780061417` | `us.kindcode.quizzik` | `Quizzik/icon-1024x1024.png` | 6 × 1320×2868 RGB |

## Validation

- All PNGs are RGB (no alpha channel).
- All iOS screenshots are 1320 × 2868 (iPhone 16 Pro Max native, accepted by ASC for 6.7" slot).
- All Android screenshots are 1080 × 2400.
- App icons are 1024 × 1024 RGB.

## How to upload

### The Narrator (iOS)

1. Open App Store Connect → Apps → The Narrator (`6780281887`).
2. **App Information** → upload `TheNarrator/icon-1024x1024.png` as the app icon if not already set.
3. Go to **iOS App** → **6.7" Display**.
4. Drag the 5 screenshots from `TheNarrator/ios-screenshots/` into the 6.7" slot.
5. The same set can be reused for the 6.5" and 5.5" slots; ASC will scale or you can downscale with `sips`/`ImageMagick` if required.

### Quizzik (iOS)

1. Open App Store Connect → Apps → Quizzik (`6780061417`).
2. Upload `Quizzik/icon-1024x1024.png` as app icon.
3. Drag the 6 screenshots from `Quizzik/ios-screenshots/` into the 6.7" slot.

### Quizzik (Android)

1. Open Google Play Console → Quizzik → Store presence → Main store listing.
2. Upload the 6 screenshots from `Quizzik/android-screenshots/` (phone screenshots).

## Notes

- The Narrator currently has 5 iOS screenshots, not 6. The planned Podcast Mode / Player shot was skipped because the simulator build has no populated content; if ASC requires a 6th, capture it after generating a sample narration.
- The Narrator subscription screenshot shows the Settings → Subscription section. The full TierSelection paywall screen navigation is currently broken from the Settings tab; fix if ASC requests an explicit paywall shot.
- Quizzik icon file is `Quizzik/assets/icon-appstore-1024.png` (source) and is also included in the package as `Quizzik/icon-1024x1024.png`.

## Source locations

- Prep script: `Medusa/scripts/prep-app-store-screenshots.py`
- The Narrator screenshots: `TheNarrator/iosScreenshots/`
- Quizzik iOS screenshots: `Quizzik/iosScreenshots/`
- Quizzik Android screenshots: `Quizzik/androidScreenshots/`
