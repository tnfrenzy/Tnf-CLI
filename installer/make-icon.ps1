# Builds the app icon from installer/logo-source.png (three logos side by side; ONLY the centre one is used).
# Outputs: installer/tnf.ico (16..256), ui/public/logo.png (128 px), ui/public/favicon-64.png.
# Run once after changing the source image, then commit the results. Windows PowerShell 5.1, ASCII only on purpose.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

# Centre logo in the 1536x1024 source: centre (752, 507), radius ~211. Crop a square, fade the edge to transparent.
$cx = 752; $cy = 507; $half = 240; $rOpaque = 222; $rZero = 240

Add-Type -TypeDefinition @"
using System; using System.Drawing; using System.Drawing.Imaging;
public static class LogoCrop {
  public static Bitmap Make(string path, int cx, int cy, int half, double r0, double r1) {
    using (Bitmap src = new Bitmap(path)) {
      int n = half * 2;
      Bitmap dst = new Bitmap(n, n, PixelFormat.Format32bppArgb);
      for (int y = 0; y < n; y++) for (int x = 0; x < n; x++) {
        Color c = src.GetPixel(cx - half + x, cy - half + y);
        double dx = x + 0.5 - half, dy = y + 0.5 - half, d = Math.Sqrt(dx * dx + dy * dy);
        double a = d <= r0 ? 1.0 : (d >= r1 ? 0.0 : 1.0 - (d - r0) / (r1 - r0));
        a = a * a * (3 - 2 * a); // smoothstep
        dst.SetPixel(x, y, Color.FromArgb((int)Math.Round(255 * a), c.R, c.G, c.B));
      }
      return dst;
    }
  }
}
"@ -ReferencedAssemblies System.Drawing

$srcFile = Join-Path $PSScriptRoot "logo-source.png"
if (-not (Test-Path $srcFile)) { throw "Missing $srcFile" }
$crop = [LogoCrop]::Make($srcFile, $cx, $cy, $half, $rOpaque, $rZero)

function Get-PngBytes([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($crop, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return ,$ms.ToArray()
}

# ICO with PNG frames (Vista+): 6-byte header + 16 bytes per frame + data.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = foreach ($s in $sizes) { ,(Get-PngBytes $s) }
$out = Join-Path $PSScriptRoot "tnf.ico"
$fs = [System.IO.File]::Create($out)
$w = New-Object System.IO.BinaryWriter($fs)
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $len = $frames[$i].Length
  $b = if ($s -ge 256) { 0 } else { $s }
  $w.Write([byte]$b); $w.Write([byte]$b)
  $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$len); $w.Write([uint32]$offset)
  $offset += $len
}
foreach ($f in $frames) { $w.Write($f) }
$w.Close()
Write-Host "Wrote $out ($((Get-Item $out).Length) bytes)"

$pub = Join-Path (Split-Path $PSScriptRoot -Parent) "ui\public"
New-Item -ItemType Directory -Force $pub | Out-Null
[System.IO.File]::WriteAllBytes((Join-Path $pub "logo.png"), (Get-PngBytes 128))
[System.IO.File]::WriteAllBytes((Join-Path $pub "favicon-64.png"), (Get-PngBytes 64))
[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot "logo-256.png"), (Get-PngBytes 256))
$crop.Dispose()
Write-Host "Wrote ui/public/logo.png, ui/public/favicon-64.png, installer/logo-256.png"
