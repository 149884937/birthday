param([int]$Port = 9333)
$ErrorActionPreference = 'Stop'
$pages = Invoke-RestMethod "http://127.0.0.1:$Port/json"
$page = $pages | Where-Object { $_.type -eq 'page' -and $_.url -like 'http://127.0.0.1:4173/*' } | Select-Object -First 1
$ws = [Net.WebSockets.ClientWebSocket]::new()
$token = [Threading.CancellationToken]::None
$ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl,$token).GetAwaiter().GetResult() | Out-Null
$script:messageId = 0
function Send-Command($method, $params) {
  $script:messageId++
  $bytes = [Text.Encoding]::UTF8.GetBytes((@{ id=$script:messageId; method=$method; params=$params } | ConvertTo-Json -Depth 15 -Compress))
  $ws.SendAsync([ArraySegment[byte]]::new($bytes),[Net.WebSockets.WebSocketMessageType]::Text,$true,$token).GetAwaiter().GetResult() | Out-Null
  do {
    $stream=[IO.MemoryStream]::new()
    do { $buf=New-Object byte[] 65536; $r=$ws.ReceiveAsync([ArraySegment[byte]]::new($buf),$token).GetAwaiter().GetResult(); $stream.Write($buf,0,$r.Count) } while(-not $r.EndOfMessage)
    $msg=[Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
  } while($msg.id -ne $script:messageId)
  if ($msg.error) { throw ($msg.error | ConvertTo-Json) }
  return $msg.result
}
function Evaluate($expression) {
  $r=Send-Command 'Runtime.evaluate' @{expression=$expression;awaitPromise=$true;returnByValue=$true}
  if ($r.exceptionDetails) { throw ($r.exceptionDetails | ConvertTo-Json -Depth 10) }
  return $r.result.value
}
try {
  Send-Command 'Emulation.setDeviceMetricsOverride' @{width=390;height=900;deviceScaleFactor=1;mobile=$true} | Out-Null
  Evaluate 'document.querySelector("#journey").scrollIntoView({block:"start",behavior:"instant"}); true' | Out-Null
  $coords=Evaluate '(() => { const svg=document.querySelector("#china-map"), m=svg.getScreenCTM(); const a=new DOMPoint(386,280).matrixTransform(m), b=new DOMPoint(562,220).matrixTransform(m); return {ax:a.x,ay:a.y,bx:b.x,by:b.y,overflow:document.documentElement.scrollWidth>innerWidth}; })()'
  if ($coords.overflow) { throw 'Mobile horizontal overflow' }
  Send-Command 'Input.dispatchMouseEvent' @{type='mousePressed';x=$coords.ax;y=$coords.ay;button='left';buttons=1;clickCount=1} | Out-Null
  for($i=1;$i -le 8;$i++) { $t=$i/8; Send-Command 'Input.dispatchMouseEvent' @{type='mouseMoved';x=($coords.ax+($coords.bx-$coords.ax)*$t);y=($coords.ay+($coords.by-$coords.ay)*$t);buttons=1} | Out-Null }
  Send-Command 'Input.dispatchMouseEvent' @{type='mouseReleased';x=$coords.bx;y=$coords.by;button='left';buttons=0;clickCount=1} | Out-Null
  $result=Evaluate 'new Promise((resolve,reject)=>{ const start=Date.now(); const timer=setInterval(()=>{ if(document.querySelector(".city-frog[data-place-id=jinan]")){clearInterval(timer);resolve("PASS actual pointer drag at mobile viewport unlocks Jinan after arrival");} else if(Date.now()-start>8000){clearInterval(timer);reject(Error(document.querySelector("#toast").textContent||"drag failed"));} },50);})'
  Write-Output $result
  $shot=Send-Command 'Page.captureScreenshot' @{format='png';captureBeyondViewport=$false}
  [IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'map-mobile-verified.png'),[Convert]::FromBase64String($shot.data))
  Evaluate 'document.querySelector(".place-card[data-place-id=chongqing]").click(); true' | Out-Null
  $shot=Send-Command 'Page.captureScreenshot' @{format='png';captureBeyondViewport=$false}
  [IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'stories-mobile-verified.png'),[Convert]::FromBase64String($shot.data))
  Evaluate 'document.querySelector("#frog-memories .memory-card").click(); true' | Out-Null
  $shot=Send-Command 'Page.captureScreenshot' @{format='png';captureBeyondViewport=$false}
  [IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'photos-mobile-verified.png'),[Convert]::FromBase64String($shot.data))
  Evaluate 'document.querySelector("#view-dialog").close(); true' | Out-Null
} finally { $ws.Dispose() }
