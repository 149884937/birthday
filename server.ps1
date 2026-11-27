param([ValidateRange(1024,65535)][int]$Port = 4173)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$listener = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse('127.0.0.1'), $Port)
$listener.Start()
Write-Output "Open http://127.0.0.1:$Port"
$allowed = @('index.html', 'styles.css', 'app.js', 'model.js', 'gift-sources.js')
 $allowed += [Uri]::UnescapeDataString('%E5%A4%AA%E8%81%AA%E6%98%8E-%E9%99%88%E7%BB%AE%E8%B4%9E.mp3')
$types = @{ '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8' }
 $types['.mp3'] = 'audio/mpeg'
try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
    $stream = $client.GetStream()
    $stream.ReadTimeout = 2000
    $stream.WriteTimeout = 5000
    $reader = [IO.StreamReader]::new($stream)
    $requestLine = $reader.ReadLine()
    if ([string]::IsNullOrWhiteSpace($requestLine)) { continue }
    while (($line = $reader.ReadLine()) -and $line -ne '') { }
    $path = if ($requestLine) { ($requestLine -split ' ')[1] } else { '/' }
    $name = [Uri]::UnescapeDataString(($path -split '\?')[0].TrimStart('/'))
    if ([string]::IsNullOrWhiteSpace($name)) { $name = 'index.html' }
    if ($allowed -notcontains $name) { $bytes = [Text.Encoding]::UTF8.GetBytes('Not found'); $header = "HTTP/1.1 404 Not Found`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"; $hb = [Text.Encoding]::ASCII.GetBytes($header); $stream.Write($hb,0,$hb.Length); $stream.Write($bytes,0,$bytes.Length); $client.Close(); continue }
    $file = Join-Path $root $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { $bytes = [Text.Encoding]::UTF8.GetBytes('Not found'); $header = "HTTP/1.1 404 Not Found`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"; $hb = [Text.Encoding]::ASCII.GetBytes($header); $stream.Write($hb,0,$hb.Length); $stream.Write($bytes,0,$bytes.Length); $client.Close(); continue }
    $bytes = [IO.File]::ReadAllBytes($file)
    $contentType = $types[[IO.Path]::GetExtension($file)]
    $header = "HTTP/1.1 200 OK`r`nContent-Type: $contentType`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
    $stream.Write($headerBytes, 0, $headerBytes.Length)
    $stream.Write($bytes, 0, $bytes.Length)
    } catch [IO.IOException] {
      # A browser can cancel requests or open an idle speculative connection.
      # Close that connection and keep serving the next one.
    } finally { $client.Close() }
  }
} finally { $listener.Stop() }
