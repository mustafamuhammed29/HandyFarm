# HandyFarm — Legitimate Use & Operational Scope

## Stated Purpose
HandyFarm is an internal test farm and automation platform engineered exclusively to automate functional, regression, network-resilience, and performance testing for first-party mobile and web applications developed and owned directly by our organization.

## Operational Boundaries & Explicit Non-Goals
1. **First-Party Application Testing Only**:
   All connected physical devices, accounts, automation workflows, and test routines operate solely on software and services that we develop, own, and control.
2. **No Platform Abuse or Account-Farming**:
   No third-party platform account-farming, scraping, terms-of-service circumvention, or fraudulent activities are in scope or permitted within this infrastructure.
3. **Hardware Integrity & Non-Tampering**:
   The farm operates on physical, non-rooted, stock OEM mobile hardware. System identifiers, IMEI registers, and hardware radio properties are strictly preserved without spoofing or tampering.
4. **Verified Baseline & Structured State Diffing**:
   Device state verification is conducted via standard Android debugging protocols (`adb`, `dumpsys`, and our first-party companion agent), asserting verified baseline state and structured diffing rather than intrusive platform modifications.
