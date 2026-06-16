DEWA SMC V6.9 EA TOKEN FINAL
File ini berisi:
server.js siap Render
public/index.html
public/app.js
PWA install HP + logo
push notification
admin approval register
delete member/request tidak dikenal
EA API key per member
MT5 account lock optional
endpoint EA:
/api/ea/verify
/api/ea/latest-signal
EA MT5: DEWA_Sniper_EA.mq5
EA MT5
EA hanya eksekusi signal SNIPER dari web.
Input EA:
SignalURL
MemberEmail
EAApiKey
TimeframeText
LotTP1
LotTP2
LotTP3
EnableTP2
EnableTP3
MaxSpreadPoints
Magic
Logic EA
TP1 dibuka dulu.
Jika TP1 selesai, TP2 dibuka.
Jika TP2 selesai, TP3 dibuka.
TP2 dapat dimatikan dengan EnableTP2=false.
TP3 dapat dimatikan dengan EnableTP3=false.
Jika salah satu posisi close loss/SL, EA menutup semua posisi DEWA dan berhenti untuk signal itu.
Setup MT5
MT5 > Tools > Options > Expert Advisors:
centang Allow WebRequest for listed URL
masukkan domain Render Anda, contoh:
https://dewa-smc-v64.onrender.com
Catatan penting
Symbol MT5 harus sama dengan pair web, contoh BTCUSDT.
Jika broker memakai nama berbeda seperti BTCUSDm, endpoint web perlu mapping symbol.
Data member di Render free masih rawan reset saat redeploy. Untuk permanen penuh gunakan MongoDB/Supabase.

V7.0 Pine State Fix
Perbaikan agar SNIPER web lebih mendekati TradingView:
EMA crossover/crossunder tetap sebagai trigger signal baru.
bullScore/bearScore memakai bobot Pine termasuk HTF +1.5.
passesGradeFilter diterapkan.
lastDirection memory diterapkan.
trade state ACTIVE disimpan di localStorage.
Signal tidak hilang saat score turun ke B selama trade belum invalid.
ACTIVE LONG/SHORT tampil seperti dashboard TradingView.
State invalid jika SL/TP3/reverse signal.
RESET SIGNAL membersihkan lock, lastDirection, dan Pine state.
Catatan:
Ini meningkatkan kemiripan logic Sniper state dengan Pine.
Selisih kecil masih bisa terjadi karena data feed TradingView vs Binance/TwelveData.

V7.1 A/A+ Only EA + Notification
Perubahan:
Push notification hanya dikirim untuk SNIPER Grade A/A+.
EA endpoint `/api/ea/latest-signal` hanya mengirim SNIPER Grade A/A+.
Grade B tidak akan menjadi entry EA.
Grade B hanya boleh tampil sebagai ACTIVE continuation jika signal A/A+ sebelumnya masih berjalan.
Server `ea-signals.json` hanya menyimpan signal SNIPER A/A+ untuk eksekusi EA.
Rule final:
A+ / A = Notify + EA Execute
B / C = Dashboard only / continuation, tidak execute EA

V7.2 SMC + Sniper 95 Final
Update:
Sniper tetap Pine State Fix.
SMC ditingkatkan dengan Pine-like state:
Pivot swing high/low.
BOS body/close validation.
CHoCH trend shift.
BOS/CHoCH valid window 10 candle.
EMA 9/20 confirmation.
ATR volatility filter.
HTF bias.
Prepare zone.
ACTIVE LONG/SHORT state memory.
Entry/TP/SL locked sampai TP/SL/reverse.
Hybrid membaca SMC state dan Sniper state.
Rule:
SNIPER Grade A/A+ saja yang kirim notifikasi dan EA execute.
SMC tetap untuk dashboard/validasi structure.
Grade B/C tidak execute EA.
Estimasi:
Sniper: mendekati 95–97% terhadap Pine core + state pada feed yang sama.
SMC: dibuat mendekati 90–95% karena SMC Pine bisa berbeda jika indikator asli memakai object/array state kompleks.

V7.3 Exact SMC Pine Core
SMC sudah dipatch berdasarkan Pine Script DewaSMC ELITE yang Anda upload:
`structurePeriod = 20`
`confirmationType = Body`
`ta.pivothigh(high, 20, 20)` dan `ta.pivotlow(low, 20, 20)`
`highBreakPending` / `lowBreakPending`
`trendDirection`
`CHoCH`
`entry = structHigh/structLow`
`targetRange = ATR14 * 2.0`
TP1/TP2/TP3/SL formula sama
Prepare zone 0.25%
EMA confirm 9/20
Volatility = ATR14 > SMA(ATR14,20)
TP hit state dihitung ulang dari histori candle
Estimasi SMC sekarang:
SMC core: ±94–97% mirip Pine pada data feed yang sama.
Selisih tetap mungkin dari feed TradingView vs Binance/TwelveData dan detail internal `ta.pivot*` pada candle real-time.

V7.4 EA SMC Priority
Aturan terbaru:
EA tidak memakai HYBRID.
EA prioritas pertama: SMC Grade A/A+.
Jika tidak ada SMC Grade A/A+, EA boleh mengambil SNIPER Grade A/A+.
SMC dan SNIPER boleh sama-sama aktif di dashboard.
Endpoint EA `/api/ea/latest-signal` memilih prioritas:
SMC A/A+
SNIPER A/A+
Notifikasi dikirim untuk:
SMC A/A+
SNIPER A/A+
Grade B/C tidak execute EA.
Partial TP tetap konsep lama:
TP1 dibuka dulu.
TP2 dibuka setelah TP1 selesai.
TP3 dibuka setelah TP2 selesai.
TP2/TP3 bisa dinonaktifkan dari input EA.
Jika salah satu posisi close loss/SL, EA close semua posisi DEWA.

V7.5 EA Pending Chain Update
EA diubah:
TP1 dibuka market langsung.
TP2/TP3 tidak market langsung, tetapi dipasang pending order sekaligus jika enabled.
TP2:
Entry = TP1
SL = original entry / entry TP1
TP = TP2
TP3:
Entry = TP2
SL = TP1
TP = TP3
Jika harga berbalik sebelum menyentuh TP1:
pending TP2/TP3 tidak aktif.
hanya TP1 market yang berisiko.
Jika salah satu posisi DEWA close loss/SL:
close semua posisi DEWA
hapus semua pending order DEWA.
Tidak open dua kali dari signal yang sama:
signal key disimpan di GlobalVariable MT5.
Prioritas signal tetap:
SMC Grade A/A+
SNIPER Grade A/A+
HYBRID diabaikan.
