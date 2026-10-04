package com.consentshare.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

public class MainActivity extends Activity implements LocationListener {
    private static final int REQUEST_PERMISSIONS = 44;
    private EditText nameInput;
    private EditText phoneInput;
    private CheckBox consentBox;
    private RadioGroup durationGroup;
    private RadioButton duration2;
    private RadioButton duration5;
    private RadioButton duration10;
    private RadioButton durationManual;
    private TextView statusView;
    private Button startButton;
    private Button stopButton;
    private WebView mapView;
    private LocationManager locationManager;
    private SharedPreferences prefs;
    private volatile boolean starting = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("consent_share", MODE_PRIVATE);
        buildUi();
        restoreProfile();
        refreshState();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(18), dp(20), dp(24));
        root.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        scroll.addView(root);

        TextView title = new TextView(this);
        title.setText("اشتراک موقعیت");
        title.setTextSize(27);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, 0, 0, dp(8));
        root.addView(title, new LinearLayout.LayoutParams(-1, -2));

        TextView intro = new TextView(this);
        intro.setText("موقعیت فقط زمانی ارسال می‌شود که خودتان اشتراک‌گذاری را روشن کنید. هنگام اشتراک یک اعلان دائمی نمایش داده می‌شود و توقف از داخل برنامه یا همان اعلان ممکن است. تاریخچه مسیر ذخیره نمی‌شود.");
        intro.setTextSize(15);
        intro.setLineSpacing(0, 1.25f);
        root.addView(intro, new LinearLayout.LayoutParams(-1, -2));

        nameInput = new EditText(this);
        nameInput.setHint("نام و نام خانوادگی");
        nameInput.setSingleLine(true);
        root.addView(nameInput, new LinearLayout.LayoutParams(-1, -2));

        phoneInput = new EditText(this);
        phoneInput.setHint("شماره موبایل");
        phoneInput.setInputType(android.text.InputType.TYPE_CLASS_PHONE);
        phoneInput.setSingleLine(true);
        root.addView(phoneInput, new LinearLayout.LayoutParams(-1, -2));

        TextView durationTitle = new TextView(this);
        durationTitle.setText("مدت اشتراک");
        durationTitle.setTextSize(17);
        durationTitle.setPadding(0, dp(14), 0, dp(4));
        root.addView(durationTitle, new LinearLayout.LayoutParams(-1, -2));

        durationGroup = new RadioGroup(this);
        durationGroup.setOrientation(RadioGroup.VERTICAL);
        durationGroup.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);

        duration2 = new RadioButton(this);
        duration2.setText("۲ ساعت");
        duration5 = new RadioButton(this);
        duration5.setText("۵ ساعت");
        duration10 = new RadioButton(this);
        duration10.setText("۱۰ ساعت");
        durationManual = new RadioButton(this);
        durationManual.setText("تا زمانی که خودم غیرفعال کنم");

        durationGroup.addView(duration2);
        durationGroup.addView(duration5);
        durationGroup.addView(duration10);
        durationGroup.addView(durationManual);
        duration2.setChecked(true);
        root.addView(durationGroup, new LinearLayout.LayoutParams(-1, -2));

        consentBox = new CheckBox(this);
        consentBox.setText("موافقم آخرین موقعیت من فقط در مدت انتخاب‌شده برای مدیر سامانه قابل مشاهده باشد و هر زمان بخواهم بتوانم آن را متوقف کنم.");
        root.addView(consentBox, new LinearLayout.LayoutParams(-1, -2));

        startButton = new Button(this);
        startButton.setText("شروع اشتراک موقعیت");
        startButton.setOnClickListener(v -> beginFlow());
        root.addView(startButton, new LinearLayout.LayoutParams(-1, -2));

        stopButton = new Button(this);
        stopButton.setText("توقف اشتراک موقعیت");
        stopButton.setOnClickListener(v -> stopSharing());
        root.addView(stopButton, new LinearLayout.LayoutParams(-1, -2));

        statusView = new TextView(this);
        statusView.setTextSize(17);
        statusView.setPadding(0, dp(12), 0, dp(10));
        root.addView(statusView, new LinearLayout.LayoutParams(-1, -2));

        TextView mapTitle = new TextView(this);
        mapTitle.setText("موقعیت فعلی شما");
        mapTitle.setTextSize(17);
        root.addView(mapTitle, new LinearLayout.LayoutParams(-1, -2));

        mapView = new WebView(this);
        WebSettings settings = mapView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        mapView.setMinimumHeight(dp(360));
        root.addView(mapView, new LinearLayout.LayoutParams(-1, dp(360)));
        mapView.loadDataWithBaseURL("https://tiles.openfreemap.org/", mapHtml(35.6892, 51.3890, false), "text/html", "UTF-8", null);

        setContentView(scroll);
    }

    private void restoreProfile() {
        nameInput.setText(prefs.getString("name", ""));
        phoneInput.setText(prefs.getString("phone", ""));
        String mode = prefs.getString("duration_mode", "2h");
        if ("5h".equals(mode)) duration5.setChecked(true);
        else if ("10h".equals(mode)) duration10.setChecked(true);
        else if ("manual".equals(mode)) durationManual.setChecked(true);
        else duration2.setChecked(true);
    }

    private void refreshState() {
        boolean active = prefs.getBoolean("active", false);
        String mode = prefs.getString("duration_mode", "2h");
        statusView.setText(active ? "اشتراک فعال است — " + durationLabel(mode) : "اشتراک‌گذاری خاموش است");
        startButton.setEnabled(!active && !starting);
        stopButton.setEnabled(active);
    }

    private String selectedDurationMode() {
        if (duration5.isChecked()) return "5h";
        if (duration10.isChecked()) return "10h";
        if (durationManual.isChecked()) return "manual";
        return "2h";
    }

    private String durationLabel(String mode) {
        if ("5h".equals(mode)) return "۵ ساعت";
        if ("10h".equals(mode)) return "۱۰ ساعت";
        if ("manual".equals(mode)) return "تا زمانی که خودتان غیرفعال کنید";
        return "۲ ساعت";
    }

    private boolean permissionsReady() {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return false;
        return Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestNeededPermissions() {
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.POST_NOTIFICATIONS}, REQUEST_PERMISSIONS);
        } else {
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, REQUEST_PERMISSIONS);
        }
    }

    private void beginFlow() {
        String name = nameInput.getText().toString().trim();
        String phone = phoneInput.getText().toString().trim();
        if (name.length() < 2 || phone.length() < 5) {
            Toast.makeText(this, "نام و شماره موبایل را کامل وارد کنید.", Toast.LENGTH_LONG).show();
            return;
        }
        if (!consentBox.isChecked()) {
            Toast.makeText(this, "برای شروع باید رضایت اشتراک موقعیت را تأیید کنید.", Toast.LENGTH_LONG).show();
            return;
        }
        if (!permissionsReady()) {
            requestNeededPermissions();
            return;
        }

        String durationMode = selectedDurationMode();
        String durationText = durationLabel(durationMode);
        new AlertDialog.Builder(this)
            .setTitle("تأیید اشتراک موقعیت")
            .setMessage("آخرین موقعیت شما برای مدیر سامانه ارسال خواهد شد. مدت انتخاب‌شده: «" + durationText + "». اعلان دائمی تا زمان پایان اشتراک نمایش داده می‌شود. آیا تأیید می‌کنید؟")
            .setNegativeButton("لغو", null)
            .setPositiveButton("تأیید و شروع", (dialog, which) -> startRemoteSession(name, phone, durationMode))
            .show();
    }

    private void startRemoteSession(String name, String phone, String durationMode) {
        if (starting) return;
        starting = true;
        refreshState();
        statusView.setText("در حال ایجاد نشست اشتراک…");

        new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("action", "start");
                body.put("display_name", name);
                body.put("phone", phone);
                body.put("duration_mode", durationMode);
                JSONObject result = ApiClient.post(body);
                if (!result.optBoolean("ok")) throw new Exception(result.optString("error", "START_FAILED"));

                String token = result.getString("device_token");
                String expiresAt = result.isNull("expires_at") ? "" : result.optString("expires_at", "");
                prefs.edit()
                    .putString("name", name)
                    .putString("phone", phone)
                    .putString("device_token", token)
                    .putString("expires_at", expiresAt)
                    .putString("duration_mode", durationMode)
                    .putBoolean("active", true)
                    .apply();

                Intent service = new Intent(this, LocationShareService.class);
                service.setAction(LocationShareService.ACTION_START);
                startForegroundService(service);

                runOnUiThread(() -> {
                    starting = false;
                    consentBox.setChecked(true);
                    refreshState();
                    startOwnLocationPreview();
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    starting = false;
                    refreshState();
                    Toast.makeText(this, "شروع اشتراک انجام نشد: " + e.getMessage(), Toast.LENGTH_LONG).show();
                });
            }
        }).start();
    }

    private void stopSharing() {
        Intent service = new Intent(this, LocationShareService.class);
        service.setAction(LocationShareService.ACTION_STOP);
        startService(service);
        prefs.edit().putBoolean("active", false).remove("expires_at").apply();
        refreshState();
        Toast.makeText(this, "درخواست توقف ارسال شد.", Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshState();
        if (prefs.getBoolean("active", false) && permissionsReady()) {
            Intent service = new Intent(this, LocationShareService.class);
            service.setAction(LocationShareService.ACTION_START);
            startForegroundService(service);
        }
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) startOwnLocationPreview();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (locationManager != null) {
            try { locationManager.removeUpdates(this); } catch (Exception ignored) {}
        }
    }

    private void startOwnLocationPreview() {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return;
        locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
        try {
            locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000, 5, this);
            locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 5000, 5, this);
            Location last = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            if (last == null) last = locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            if (last != null) showOnMap(last);
        } catch (Exception ignored) {}
    }

    @Override
    public void onLocationChanged(Location location) {
        showOnMap(location);
    }

    private void showOnMap(Location location) {
        mapView.loadDataWithBaseURL("https://tiles.openfreemap.org/", mapHtml(location.getLatitude(), location.getLongitude(), true), "text/html", "UTF-8", null);
    }

    private String mapHtml(double lat, double lon, boolean current) {
        String label = current ? "موقعیت فعلی شما" : "نقشه";
        return "<!doctype html><html dir='rtl'><head><meta name='viewport' content='width=device-width,initial-scale=1'>" +
            "<link rel='stylesheet' href='https://unpkg.com/maplibre-gl@6.11.2/dist/maplibre-gl.css'>" +
            "<style>html,body,#map{height:100%;margin:0}body{font-family:sans-serif}</style></head><body><div id='map'></div>" +
            "<script src='https://unpkg.com/maplibre-gl@6.11.2/dist/maplibre-gl.js'></script>" +
            "<script>if(maplibregl.setRTLTextPlugin){maplibregl.setRTLTextPlugin('https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.3.0/dist/mapbox-gl-rtl-text.js',true).catch(function(){});}const map=new maplibregl.Map({container:'map',style:'https://tiles.openfreemap.org/styles/liberty',center:[" + lon + "," + lat + "],zoom:14});" +
            "new maplibregl.Marker().setLngLat([" + lon + "," + lat + "]).setPopup(new maplibregl.Popup().setText('" + label + "')).addTo(map);</script></body></html>";
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_PERMISSIONS) return;
        if (permissionsReady()) {
            beginFlow();
        } else {
            new AlertDialog.Builder(this)
                .setTitle("مجوز لازم است")
                .setMessage("برای اشتراک رضایت‌محور، دسترسی مکان و نمایش اعلان لازم است. می‌توانید مجوزها را از تنظیمات Android فعال کنید.")
                .setPositiveButton("تنظیمات", (d, w) -> startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:" + getPackageName()))))
                .setNegativeButton("لغو", null)
                .show();
        }
    }
}
