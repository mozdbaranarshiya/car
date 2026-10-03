# سامانه اشتراک موقعیت رضایت‌محور

این مخزن شامل دو بخش است:

- `android/`: برنامه اندروید برای اشتراک داوطلبانه موقعیت. اشتراک فقط پس از تایید صریح کاربر شروع می‌شود، یک اعلان دائمی نشان داده می‌شود و کاربر هر لحظه می‌تواند از داخل برنامه یا اعلان، اشتراک را متوقف کند.
- `site/`: پنل مدیر برای GitHub Pages با نقشه OpenFreeMap/MapLibre، جستجو با شماره موبایل و ورود Supabase Auth + TOTP/MFA سازگار با Ente Auth.

## حریم خصوصی

سامانه تاریخچه مسیر نگه نمی‌دارد. فقط آخرین موقعیت نشست فعال ذخیره می‌شود. هر نشست حداکثر ۸ ساعت اعتبار دارد و هنگام توقف یا انقضا مختصات پاک می‌شود.

## Backend

Edge Function با نام `consent-location` روی Supabase مستقر شده است. سورس مرجع آن در `supabase/functions/consent-location/index.ts` نگهداری می‌شود.

## ساخت APK

Workflow با نام **Build Android APK** فایل `app-debug.apk` را می‌سازد و به عنوان artifact منتشر می‌کند.

## GitHub Pages

Workflow با نام **Deploy GitHub Pages** پوشه `site/` را منتشر می‌کند. اگر Pages برای مخزن هنوز فعال نشده باشد، یک بار در Settings → Pages، منبع را روی GitHub Actions قرار دهید.
