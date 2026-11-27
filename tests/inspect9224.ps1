param([string]$Expression = 'document.querySelector("#test-results")?.textContent', [string]$Screenshot = '', [int]$Width = 0, [string]$ExpressionFile = '')
$ErrorActionPreference = 'Stop'
$pages = Invoke-RestMethod 'http://127.0.0.1:9224/json'
$page = $pages | Where-Object { $_.type -eq 'page' -and $_.url -like 'http://127.0.0.1:4173/*' } | Select-Object -First 1
$ws = [Net.WebSockets.ClientWebSocket]::new()
$cancel = [Threading.CancellationToken]::None
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, $cancel).GetAwaiter().GetResult()
$method = 'Runtime.evaluate'
if ($ExpressionFile) { $Expression = [IO.File]::ReadAllText((Join-Path (Get-Location) $ExpressionFile)) }
$params = @{expression=$Expression;returnByValue=$true;awaitPromise=$true}
if ($Width) { $method = 'Emulation.setDeviceMetricsOverride'; $params = @{width=$Width;height=900;deviceScaleFactor=1;mobile=$true} }
if ($Screenshot) { $method = 'Page.captureScreenshot'; $params = @{format='png';captureBeyondViewport=$true} }
if ($Width -and $Screenshot) {
  $resize = @{id=0;method='Emulation.setDeviceMetricsOverride';params=@{width=$Width;height=900;deviceScaleFactor=1;mobile=$true}} | ConvertTo-Json -Compress
  $resizeBytes = [Text.Encoding]::UTF8.GetBytes($resize)
  $ws.SendAsync([ArraySegment[byte]]::new($resizeBytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, $cancel).GetAwaiter().GetResult() | Out-Null
}
$json = @{id=1;method=$method;params=$params} | ConvertTo-Json -Compress -Depth 10
$bytes = [Text.Encoding]::UTF8.GetBytes($json)
$ws.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, $cancel).GetAwaiter().GetResult()
do {
  $stream = [IO.MemoryStream]::new()
  do {
    $buffer = New-Object byte[] 65536
    $result = $ws.ReceiveAsync([ArraySegment[byte]]::new($buffer), $cancel).GetAwaiter().GetResult()
    $stream.Write($buffer,0,$result.Count)
  } while (-not $result.EndOfMessage)
  $message = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
} while ($message.id -ne 1)
if ($Screenshot) { [IO.File]::WriteAllBytes($Screenshot,[Convert]::FromBase64String($message.result.data)); Write-Output $Screenshot }
else { $message.result | ConvertTo-Json -Depth 15 }
$ws.Dispose()

