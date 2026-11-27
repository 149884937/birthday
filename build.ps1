$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$bundle = @{
  html = [IO.File]::ReadAllText((Join-Path $root 'index.html'))
  css = [IO.File]::ReadAllText((Join-Path $root 'styles.css'))
  js = [IO.File]::ReadAllText((Join-Path $root 'app.js'))
  model = [IO.File]::ReadAllText((Join-Path $root 'model.js'))
  music = 'data:audio/mpeg;base64,' + [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $root ([Uri]::UnescapeDataString('%E5%A4%AA%E8%81%AA%E6%98%8E-%E9%99%88%E7%BB%AE%E8%B4%9E.mp3')))))
} | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $root 'gift-sources.js'), ('window.GIFT_SOURCES = ' + $bundle + ';'), [Text.UTF8Encoding]::new($false))
Write-Output 'Share resources updated.'
