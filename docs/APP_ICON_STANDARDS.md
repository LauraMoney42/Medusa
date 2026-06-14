# App Icon Standards — Medusa Reference

**Purpose:** One-stop reference for generating iOS/Android app icons from a user-provided logo image. Use this doc whenever a user says *"here's my logo, make app icons."*

---

## 1. iOS App Icon Sizes

Apple requires icons in **PNG** format, **no alpha channel** (opaque background), **sRGB color space**.

| Size (px) | Point Size | Usage | Filename Convention |
|-----------|-----------|-------|---------------------|
| **1024×1024** | 1024pt @1x | App Store | `AppIcon-1024.png` |
| **180×180** | 60pt @3x | iPhone Home Screen | `AppIcon-60@3x.png` |
| **120×120** | 60pt @2x | iPhone Home Screen | `AppIcon-60@2x.png` |
| **167×167** | 83.5pt @2x | iPad Pro Home Screen | `AppIcon-83.5@2x.png` |
| **152×152** | 76pt @2x | iPad Home Screen | `AppIcon-76@2x.png` |
| **87×87** | 29pt @3x | iPhone Settings | `AppIcon-29@3x.png` |
| **58×58** | 29pt @2x | iPhone Settings | `AppIcon-29@2x.png` |
| **80×80** | 40pt @2x | iPhone Spotlight | `AppIcon-40@2x.png` |
| **40×40** | 20pt @2x | iPad Notifications | `AppIcon-20@2x.png` |

### iOS Rules
- **Format:** PNG
- **Transparency:** NO — fill the canvas; no rounded corners (iOS masks automatically)
- **Color space:** sRGB
- **Rounding:** Do NOT pre-round corners. iOS applies its own mask.
- **Safe area:** Keep logo within center ~80% of canvas to avoid clipping by mask

---

## 2. Android Adaptive Icons

Android 8.0+ uses **adaptive icons** — two layers that the system composites:
- **Foreground:** The logo (can have transparency)
- **Background:** Solid color or subtle pattern (no transparency)

### Adaptive Icon Sizes (per density)

| Density | Foreground (px) | Background (px) | Scale Factor |
|---------|----------------|-----------------|--------------|
| **mdpi** | 108×108 | 108×108 | 1.0× |
| **hdpi** | 162×162 | 162×162 | 1.5× |
| **xhdpi** | 216×216 | 216×216 | 2.0× |
| **xxhdpi** | 324×324 | 324×324 | 3.0× |
| **xxxhdpi** | 432×432 | 432×432 | 4.0× |

### Legacy Icon Sizes (pre-Android 8.0)

| Density | Size (px) | Filename |
|---------|-----------|----------|
| **mdpi** | 48×48 | `ic_launcher.png` |
| **hdpi** | 72×72 | `ic_launcher.png` |
| **xhdpi** | 96×96 | `ic_launcher.png` |
| **xxhdpi** | 144×144 | `ic_launcher.png` |
| **xxxhdpi** | 192×192 | `ic_launcher.png` |

### Android Rules
- **Format:** PNG
- **Foreground:** Can have transparency, but logo should be centered
- **Background:** Opaque. Use brand color or simple gradient.
- **Safe zone:** Keep critical logo elements within the center 66×66dp circle (the system may crop to circle, squircle, or rounded rect depending on OEM)
- **Play Store:** 512×512 PNG, 32-bit, max 1MB

---

## 3. Expo `app.json` Snippet

Use this as the baseline for React Native (Expo) projects. Adjust paths as needed.

```json
{
  "expo": {
    "name": "AppName",
    "slug": "app-name",
    "version": "1.0.0",
    "icon": "./assets/icon.png",
    "ios": {
      "bundleIdentifier": "com.kindcode.appname",
      "icon": "./assets/icon-ios.png",
      "requireFullScreen": true
    },
    "android": {
      "package": "com.kindcode.appname",
      "adaptiveIcon": {
        "foregroundImage": "./assets/adaptive-icon-fg.png",
        "backgroundImage": "./assets/adaptive-icon-bg.png"
      }
    },
    "plugins": [
      [
        "expo-splash-screen",
        {
          "image": "./assets/splash.png",
          "resizeMode": "contain",
          "backgroundColor": "#ffffff"
        }
      ]
    ]
  }
}
```

**Key fields:**
- `icon` — Universal fallback (1024×1024 PNG)
- `ios.icon` — iOS-specific if different from universal
- `android.adaptiveIcon.foregroundImage` — Logo with transparency (min 432×432)
- `android.adaptiveIcon.backgroundImage` — Solid background (min 432×432)

---

## 4. Step-by-Step: User Provides a Logo Image

### Step 1 — Receive & Inspect
- Accept any common format: PNG, JPG, SVG, AI, PSD, Figma link
- **Minimum quality:** 1024×1024px recommended. If smaller, upscale with care (AI upscaler preferred over bicubic).
- Check for transparency: if the logo has a transparent background, ask user for brand background color OR default to white.

### Step 2 — Generate iOS Icons
1. Start with a **1024×1024** master canvas
2. Fill background with brand color (opaque — no transparency)
3. Center logo within safe zone (~820×820px centered)
4. Export all 9 sizes listed in Section 1
5. Name files per convention
6. Place in `assets/ios/AppIcon.appiconset/`
7. Generate `Contents.json` (Xcode asset catalog manifest)

### Step 3 — Generate Android Adaptive Icons
1. Create **432×432** master for xxxhdpi
2. **Foreground:** Logo on transparent background, centered, within 288×288 safe zone
3. **Background:** Solid 432×432 color/pattern
4. Scale down to xxhdpi (324), xhdpi (216), hdpi (162), mdpi (108)
5. Place in:
   ```
   android/app/src/main/res/
   ├── mipmap-mdpi/
   ├── mipmap-hdpi/
   ├── mipmap-xhdpi/
   ├── mipmap-xxhdpi/
   ├── mipmap-xxxhdpi/
   └── mipmap-anydpi-v26/
       ├── ic_launcher_foreground.png
       └── ic_launcher_background.png
   ```

### Step 4 — Generate Legacy Android Icons
1. Use the same master but as a single flattened image
2. Export 48/72/96/144/192 px squares
3. Place in corresponding `mipmap-*` folders as `ic_launcher.png`

### Step 5 — Expo Projects (The Narrator, ScholarAI, etc.)
1. Export `icon.png` (1024×1024, no transparency) → `./assets/`
2. Export `adaptive-icon-fg.png` (432×432, transparent bg) → `./assets/`
3. Export `adaptive-icon-bg.png` (432×432, solid) → `./assets/`
4. Update `app.json` per Section 3
5. Run `npx expo prebuild` to sync to native platforms
6. Rebuild: `npx expo run:ios` / `npx expo run:android`

### Step 6 — Verification Checklist
- [ ] iOS: All 9 sizes present, no transparency, sRGB
- [ ] Android: 5 densities × 2 layers (fg + bg) = 10 files
- [ ] Android legacy: 5 densities × 1 icon = 5 files
- [ ] Play Store: 512×512 PNG ≤ 1MB
- [ ] App Store: 1024×1024 PNG, no alpha
- [ ] Expo: `app.json` paths correct, `expo prebuild` succeeds

---

## 5. Quick Reference Table

| Platform | Count | Master Size | Format | Transparency |
|----------|-------|-------------|--------|-------------|
| iOS | 9 icons | 1024×1024 | PNG | ❌ No |
| Android Adaptive | 10 files (5× fg + 5× bg) | 432×432 | PNG | FG: ✅ / BG: ❌ |
| Android Legacy | 5 icons | 192×192 | PNG | ❌ No |
| Play Store | 1 icon | 512×512 | PNG | ❌ No |
| **Total** | **25 files** | — | — | — |

---

## 6. Tools

- **Figma:** Best for generating all sizes from a master component
- **Sketch:** Symbol-based export
- **ImageMagick (CLI):** Batch resize script
  ```bash
  for size in 1024 180 120 167 152 87 58 80 40; do
    convert master.png -resize ${size}x${size} icon-${size}.png
  done
  ```
- **Android Studio:** Built-in Image Asset Studio for adaptive icons
- **Expo:** `npx expo prebuild` handles native sync

---

*Last updated: 2026-05-03 by Dev2*
