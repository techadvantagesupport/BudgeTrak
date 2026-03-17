package com.syncbudget.app.ui.components

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AccountBalanceWallet
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Collections
import androidx.compose.material.icons.filled.PhotoCamera
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID
import kotlin.math.roundToInt

private const val MAX_IMAGE_DIMENSION = 1000
private const val THUMBNAIL_SIZE = 200
private val PHOTO_ROW_HEIGHT = 56.dp

/**
 * Wraps a transaction row with swipe-left-to-reveal-photos.
 *
 * Architecture: the photo panel sits behind the transaction row at the
 * same position. The transaction row slides left via offset, revealing
 * the photo panel underneath. This avoids wide-Row layout issues.
 */
@Composable
fun SwipeablePhotoRow(
    transactionId: Int,
    photos: List<Bitmap?>,
    onPhotosAdded: (List<File>) -> Unit,
    onSwipeOpen: () -> Unit = {},
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current

    var containerWidthPx by remember { mutableIntStateOf(0) }
    val offsetX = remember { Animatable(0f) }

    var showCameraPicker by remember { mutableStateOf(false) }
    var tempPhotoUri by remember { mutableStateOf<Uri?>(null) }

    val cameraLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture()
    ) { success ->
        if (success && tempPhotoUri != null) {
            scope.launch {
                val saved = withContext(Dispatchers.IO) {
                    processAndSaveImage(context, tempPhotoUri!!, transactionId)
                }
                if (saved != null) onPhotosAdded(listOf(saved))
            }
        }
    }

    val galleryLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.GetMultipleContents()
    ) { uris ->
        val remaining = 5 - photos.count { it != null }
        val toProcess = uris.take(remaining)
        scope.launch {
            val saved = withContext(Dispatchers.IO) {
                toProcess.mapNotNull { uri ->
                    processAndSaveImage(context, uri, transactionId)
                }
            }
            if (saved.isNotEmpty()) onPhotosAdded(saved)
        }
    }

    val widthPx = containerWidthPx.toFloat()

    Box(
        modifier = modifier
            .fillMaxWidth()
            .clipToBounds()
            .onSizeChanged { containerWidthPx = it.width }
    ) {
        // Layer 1 (back): Photo panel — always at position 0, revealed when
        // the transaction row slides left
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(PHOTO_ROW_HEIGHT)
                .background(MaterialTheme.colorScheme.surfaceVariant)
                .pointerInput(Unit) {
                    // Swipe right on the photo panel to restore transaction
                    detectHorizontalDragGestures(
                        onDragEnd = {
                            scope.launch {
                                if (offsetX.value > -widthPx * 0.7f) {
                                    offsetX.animateTo(0f, tween(250))
                                } else {
                                    offsetX.animateTo(-widthPx, tween(250))
                                }
                            }
                        }
                    ) { _, dragAmount ->
                        scope.launch {
                            val new = (offsetX.value + dragAmount).coerceIn(-widthPx, 0f)
                            offsetX.snapTo(new)
                        }
                    }
                },
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Camera handle (58dp = ~60% wider than original 36dp)
            Box(
                modifier = Modifier
                    .width(58.dp)
                    .fillMaxHeight()
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f))
                    .clickable { showCameraPicker = true },
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = Icons.Filled.CameraAlt,
                    contentDescription = "Photos",
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(20.dp)
                )
                DropdownMenu(
                    expanded = showCameraPicker,
                    onDismissRequest = { showCameraPicker = false }
                ) {
                    DropdownMenuItem(
                        text = { Text("Camera") },
                        leadingIcon = { Icon(Icons.Filled.PhotoCamera, null) },
                        onClick = {
                            showCameraPicker = false
                            val file = File(context.cacheDir, "receipt_capture_${UUID.randomUUID()}.jpg")
                            tempPhotoUri = androidx.core.content.FileProvider.getUriForFile(
                                context, "${context.packageName}.fileprovider", file
                            )
                            cameraLauncher.launch(tempPhotoUri!!)
                        }
                    )
                    DropdownMenuItem(
                        text = { Text("Gallery") },
                        leadingIcon = { Icon(Icons.Filled.Collections, null) },
                        onClick = {
                            showCameraPicker = false
                            galleryLauncher.launch("image/*")
                        }
                    )
                }
            }

            // 5 photo frames — explicit square size
            val frameSize = PHOTO_ROW_HEIGHT - 8.dp
            Row(
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                for (i in 0 until 5) {
                    val thumb = photos.getOrNull(i)
                    Box(
                        modifier = Modifier
                            .size(frameSize)
                            .clip(RoundedCornerShape(6.dp))
                            .background(
                                if (thumb != null) Color.Transparent
                                else MaterialTheme.colorScheme.surface
                            )
                            .border(
                                1.dp,
                                MaterialTheme.colorScheme.onSurface.copy(alpha = 0.2f),
                                RoundedCornerShape(6.dp)
                            ),
                        contentAlignment = Alignment.Center
                    ) {
                        if (thumb != null) {
                            Image(
                                bitmap = thumb.asImageBitmap(),
                                contentDescription = "Receipt photo ${i + 1}",
                                contentScale = ContentScale.Crop,
                                modifier = Modifier
                                    .fillMaxSize()
                                    .clip(RoundedCornerShape(6.dp))
                            )
                        } else {
                            Icon(
                                imageVector = Icons.Filled.CameraAlt,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.2f),
                                modifier = Modifier.size(16.dp)
                            )
                        }
                    }
                }
            }

        }

        // Layer 2 (front): Transaction row — slides left to reveal photo panel
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .offset { IntOffset(offsetX.value.roundToInt(), 0) }
                .background(MaterialTheme.colorScheme.background)
                .pointerInput(Unit) {
                    // Swipe left on the transaction to reveal photos
                    detectHorizontalDragGestures(
                        onDragEnd = {
                            scope.launch {
                                if (offsetX.value < -widthPx * 0.3f) {
                                    offsetX.animateTo(-widthPx, tween(250))
                                    onSwipeOpen()  // collapse expanded categories
                                } else {
                                    offsetX.animateTo(0f, tween(250))
                                }
                            }
                        }
                    ) { _, dragAmount ->
                        scope.launch {
                            val new = (offsetX.value + dragAmount).coerceIn(-widthPx, 0f)
                            offsetX.snapTo(new)
                        }
                    }
                }
        ) {
            content()
        }
    }
}

private fun processAndSaveImage(
    context: android.content.Context,
    uri: Uri,
    transactionId: Int
): File? {
    return try {
        val inputStream = context.contentResolver.openInputStream(uri) ?: return null
        val original = BitmapFactory.decodeStream(inputStream)
        inputStream.close()
        if (original == null) return null

        val resized = resizeBitmap(original, MAX_IMAGE_DIMENSION)

        val receiptDir = File(context.filesDir, "receipts")
        receiptDir.mkdirs()
        val fileName = "receipt_${transactionId}_${UUID.randomUUID()}.jpg"
        val fullFile = File(receiptDir, fileName)
        fullFile.outputStream().use { out ->
            resized.compress(Bitmap.CompressFormat.JPEG, 70, out)
        }

        val thumbDir = File(context.filesDir, "receipt_thumbs")
        thumbDir.mkdirs()
        val thumb = resizeBitmap(resized, THUMBNAIL_SIZE)
        File(thumbDir, fileName).outputStream().use { out ->
            thumb.compress(Bitmap.CompressFormat.JPEG, 70, out)
        }

        if (resized !== original) original.recycle()
        if (thumb !== resized) thumb.recycle()

        fullFile
    } catch (e: Exception) {
        android.util.Log.w("SwipeablePhotoRow", "Failed to process image: ${e.message}")
        null
    }
}

private fun resizeBitmap(bitmap: Bitmap, maxDimension: Int): Bitmap {
    val width = bitmap.width
    val height = bitmap.height
    if (width <= maxDimension && height <= maxDimension) return bitmap

    val scale = maxDimension.toFloat() / maxOf(width, height)
    val newWidth = (width * scale).toInt()
    val newHeight = (height * scale).toInt()
    return Bitmap.createScaledBitmap(bitmap, newWidth, newHeight, true)
}

fun loadReceiptThumbnail(context: android.content.Context, fileName: String): Bitmap? {
    return try {
        val file = File(File(context.filesDir, "receipt_thumbs"), fileName)
        if (!file.exists()) return null
        BitmapFactory.decodeFile(file.absolutePath)
    } catch (_: Exception) { null }
}
