$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$card = [IO.File]::ReadAllText($env:OUR_DAYS_CARD_DATA, [Text.Encoding]::UTF8) | ConvertFrom-Json
$image = New-Object Drawing.Bitmap(720, 960)
$surface = [Drawing.Graphics]::FromImage($image)
$surface.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
$surface.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$surface.Clear([Drawing.ColorTranslator]::FromHtml('#F3ECE2'))

$paper = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#FFFBF3'))
$green = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#284339'))
$muted = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#817268'))
$accent = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#DAE4D7'))
$rule = New-Object Drawing.Pen([Drawing.ColorTranslator]::FromHtml('#587866'), 4)
$rule.StartCap = [Drawing.Drawing2D.LineCap]::Round
$rule.EndCap = [Drawing.Drawing2D.LineCap]::Round

$center = New-Object Drawing.StringFormat
$center.Alignment = [Drawing.StringAlignment]::Center
$center.LineAlignment = [Drawing.StringAlignment]::Center
$center.Trimming = [Drawing.StringTrimming]::EllipsisCharacter
$center.FormatFlags = [Drawing.StringFormatFlags]::NoWrap

$labelFont = New-Object Drawing.Font('Malgun Gothic', 26, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
$authorFont = New-Object Drawing.Font('Malgun Gothic', 51, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
$dateFont = New-Object Drawing.Font('Malgun Gothic', 29, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)

try {
    $surface.FillRectangle($paper, 96, 166, 528, 628)
    $surface.FillEllipse($accent, 317, 271, 86, 86)
    $surface.DrawLine($rule, 345, 310, 345, 318)
    $surface.DrawLine($rule, 355, 304, 355, 324)
    $surface.DrawLine($rule, 365, 300, 365, 328)
    $surface.DrawLine($rule, 375, 309, 375, 319)
    $surface.DrawString('목소리 기록', $labelFont, $muted, (New-Object Drawing.RectangleF(120, 377, 480, 40)), $center)
    $surface.DrawString([string]$card.author, $authorFont, $green, (New-Object Drawing.RectangleF(120, 430, 480, 88)), $center)
    $surface.DrawString([string]$card.date, $dateFont, $muted, (New-Object Drawing.RectangleF(120, 528, 480, 48)), $center)
    $image.Save([string]$card.output, [Drawing.Imaging.ImageFormat]::Png)
} finally {
    foreach ($resource in @($paper, $green, $muted, $accent, $rule, $center, $labelFont, $authorFont, $dateFont, $surface, $image)) {
        $resource.Dispose()
    }
}
