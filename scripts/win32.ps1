# Windows helper for agent-overlay. Emits JSON on stdout.
#   -Action displays            list monitors in logical (DPI-scaled) coordinates
#   -Action windows             list top-level visible windows
#   -Action focus -Handle <hwnd>  bring a window to the foreground
#   -Action capture -Index <n> -Out <path>   save one monitor as a PNG
param(
  [Parameter(Mandatory = $true)][ValidateSet('displays', 'windows', 'focus', 'capture')][string]$Action,
  [long]$Handle = 0,
  [int]$Index = 0,
  [string]$Out = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

# The Win32 interop used to be an inline here-string, which meant PowerShell
# recompiled it with csc on every single invocation - about 95ms of the ~400ms
# each call cost. The same source now lives in win32.cs and is precompiled to a
# DLL at build time; the inline path stays as a fallback for checkouts where no
# compiler was available.
$csPath = Join-Path $PSScriptRoot 'win32.cs'
$dllPath = Join-Path $PSScriptRoot 'win32.dll'
if (Test-Path $dllPath) {
  Add-Type -Path $dllPath
} else {
  Add-Type -TypeDefinition (Get-Content $csPath -Raw) -ReferencedAssemblies System.Windows.Forms, System.Drawing
}

function Get-Displays {
  # Note: never use $_ inside the switch below - there it refers to the switch
  # condition, not the pipeline item. Explicit loops keep this unambiguous.
  $out = New-Object System.Collections.ArrayList
  $i = 0
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $s.Bounds
    [void]$out.Add([pscustomobject]@{
        index   = $i
        name    = $s.DeviceName
        primary = [bool]$s.Primary
        x       = $b.X
        y       = $b.Y
        width   = $b.Width
        height  = $b.Height
      })
    $i++
  }
  return $out.ToArray()
}

function Save-Capture([int]$idx, [string]$out) {
  # This process is deliberately NOT DPI-aware, so the bitmap comes back the
  # same size as Screen.Bounds - i.e. in the coordinate space clicks use.
  Add-Type -AssemblyName System.Drawing
  $screens = [System.Windows.Forms.Screen]::AllScreens
  if ($idx -lt 0 -or $idx -ge $screens.Length) { throw "no display at index $idx" }
  $b = $screens[$idx].Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try { $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size) } finally { $g.Dispose() }
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  finally { $bmp.Dispose() }
  return [pscustomobject]@{ path = $out; width = $b.Width; height = $b.Height }
}

# -InputObject (not the pipeline) so a single-element array stays an array.
switch ($Action) {
  'displays' { ConvertTo-Json -InputObject @(Get-Displays) -Compress -Depth 4 }
  'windows' { ConvertTo-Json -InputObject @([AgentOverlayWin32]::List()) -Compress -Depth 4 }
  'focus' { ConvertTo-Json -InputObject ([pscustomobject]@{ status = [AgentOverlayWin32]::Focus($Handle) }) -Compress }
  'capture' { ConvertTo-Json -InputObject (Save-Capture $Index $Out) -Compress }
}
