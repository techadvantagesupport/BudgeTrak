# Architecture Notes

## Key Files
- `app/src/main/java/com/syncbudget/app/MainActivity.kt` - Entry point
- `app/src/main/java/com/syncbudget/app/ui/components/FlipDigit.kt` - Core flip animation
- `app/src/main/java/com/syncbudget/app/ui/components/FlipDisplay.kt` - Multi-digit display
- `app/src/main/java/com/syncbudget/app/ui/screens/MainScreen.kt` - Main screen
- `app/src/main/java/com/syncbudget/app/sound/FlipSoundPlayer.kt` - Procedural sound
- `app/src/main/java/com/syncbudget/app/ui/theme/` - Color.kt, Theme.kt, Type.kt

## Flip Animation Design
- Each digit: upper/lower half with 3D rotationX via graphicsLayer
- Steps through intermediate digits one at a time (wrapping 9→0)
- 250ms per step with LinearOutSlowInEasing
- Sound triggered at animation midpoint via SoundPool
- cameraDistance = 12f * density for realistic 3D perspective
