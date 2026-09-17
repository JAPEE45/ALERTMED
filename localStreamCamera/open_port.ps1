# Requires Run as Administrator
if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Warning "Please run this script as Administrator."
    Pause
    exit
}

Write-Host "Adding Firewall Rule to allow incoming connections on port 5000..."
New-NetFirewallRule -DisplayName "Allow Flask Server Port 5000" -Direction Inbound -LocalPort 5000 -Protocol TCP -Action Allow

Write-Host "Rule added successfully!"
Pause
