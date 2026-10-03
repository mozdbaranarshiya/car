package ir.radyabi.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;
import org.maplibre.android.MapLibre;
import org.maplibre.android.maps.MapView;
import org.maplibre.android.maps.MapLibreMap;
import org.maplibre.android.annotations.Marker;
import org.maplibre.android.annotations.MarkerOptions;
import org.maplibre.android.camera.CameraUpdateFactory;
import org.maplibre.android.geometry.LatLng;
import java.text.DateFormat;
import java.util.Date;
import java.util.Locale;

public final class MainActivity extends Activity implements LocationListener {
    private static final int INK=Color.rgb(20,40,61), BLUE=Color.rgb(20,91,204), MUTED=Color.rgb(91,110,131);
    private State state;
    private LinearLayout root;
    private String page="";
    private MapView mapView;
    private MapLibreMap map;
    private Marker marker;
    private boolean started=false,resumed=false,centered=false;
    private LocationManager locations;
    private JSONObject displayLocation;
    private TextView sharingStatus, fixStatus, mapError;
    private Button sharingButton;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final Runnable refresh=new Runnable(){@Override public void run(){updateHome();handler.postDelayed(this,1000);}};

    private int dp(int n){return Math.round(n*getResources().getDisplayMetrics().density);}
    private GradientDrawable surface(int color,int radius){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d;}
    private TextView text(String value,int size,int color){TextView t=new TextView(this);t.setText(value);t.setTextSize(size);t.setTextColor(color);t.setGravity(Gravity.RIGHT);t.setLineSpacing(dp(4),1);return t;}
    private void gap(LinearLayout layout,int height){View v=new View(this);layout.addView(v,new LinearLayout.LayoutParams(1,dp(height)));}
    private Button button(String label,boolean primary){Button b=new Button(this);b.setText(label);b.setTextSize(16);b.setAllCaps(false);b.setTextColor(primary?Color.WHITE:BLUE);b.setBackground(surface(primary?BLUE:Color.rgb(231,240,253),10));b.setMinHeight(dp(48));return b;}
    private void addButton(LinearLayout parent,Button b){LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,dp(52));params.topMargin=dp(12);parent.addView(b,params);}
    private EditText field(LinearLayout form,String label,String hint,int type){
        TextView l=text(label,15,INK);l.setTypeface(null,Typeface.BOLD);form.addView(l);gap(form,5);
        EditText edit=new EditText(this);edit.setHint(hint);edit.setTextSize(16);edit.setTextColor(INK);edit.setInputType(type);edit.setSingleLine(true);
        edit.setPadding(dp(12),dp(8),dp(12),dp(8));GradientDrawable bg=surface(Color.WHITE,10);bg.setStroke(dp(1),Color.rgb(186,204,222));edit.setBackground(bg);
        form.addView(edit,new LinearLayout.LayoutParams(-1,dp(54)));gap(form,16);return edit;
    }
    private void clearMap(){
        if(mapView!=null){if(resumed)mapView.onPause();if(started)mapView.onStop();mapView.onDestroy();mapView=null;map=null;marker=null;}
        if(locations!=null)locations.removeUpdates(this);
        handler.removeCallbacks(refresh);centered=false;
    }
    private LinearLayout screen(boolean scroll){
        clearMap();root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);root.setBackgroundColor(Color.rgb(241,245,250));
        root.setOnApplyWindowInsetsListener((view,insets)->{
            int top,bottom,left,right;
            if(Build.VERSION.SDK_INT>=30){var bars=insets.getInsets(WindowInsets.Type.systemBars()|WindowInsets.Type.ime());top=bars.top;bottom=bars.bottom;left=bars.left;right=bars.right;}
            else{top=insets.getSystemWindowInsetTop();bottom=insets.getSystemWindowInsetBottom();left=insets.getSystemWindowInsetLeft();right=insets.getSystemWindowInsetRight();}
            view.setPadding(left,top,right,bottom);return insets;
        });
        setContentView(root);LinearLayout content=new LinearLayout(this);content.setOrientation(LinearLayout.VERTICAL);content.setPadding(dp(20),dp(20),dp(20),dp(20));
        if(scroll){ScrollView view=new ScrollView(this);view.setFillViewport(true);view.addView(content);root.addView(view,new LinearLayout.LayoutParams(-1,-1));}
        else root.addView(content,new LinearLayout.LayoutParams(-1,-2));
        return content;
    }
    private void heading(LinearLayout content,String sub){
        TextView name=text("ردیابی افراد",26,INK);name.setTypeface(null,Typeface.BOLD);content.addView(text("به نام خدا",14,MUTED));gap(content,8);content.addView(name);gap(content,6);content.addView(text(sub,16,MUTED));gap(content,24);
    }
    @Override public void onCreate(Bundle savedInstanceState){super.onCreate(savedInstanceState);state=new State(this);locations=getSystemService(LocationManager.class);MapLibre.getInstance(this);showCurrent();}
    private void showCurrent(){
        if(state.registered()&&state.foregroundPermission()){showHome();return;}
        if(!state.prefs.getBoolean("explained",false)){showDisclosure();return;}
        if(!state.alwaysPermission()){showPermissions();return;}
        if(state.registered())showHome();else showRegistration();
    }
    private void showDisclosure(){
        page="disclosure";LinearLayout content=screen(true);heading(content,"اشتراک موقعیت با مدیر سامانه");
        content.addView(text("این برنامه با اجازهٔ شما، موقعیت گوشی را حتی زمانی که برنامه بسته است دریافت می‌کند و از طریق اینترنت به مدیر سامانه می‌فرستد. نام و شماره موبایل شما همراه آخرین موقعیت برای مدیر نمایش داده می‌شود.",17,INK));gap(content,16);
        content.addView(text("برای این کار، دسترسی مکان «همیشه» لازم است. ارسال پس از تأیید جداگانهٔ شما آغاز می‌شود و هر زمان از داخل برنامه یا اعلان می‌توانید آن را متوقف کنید.",16,MUTED));
        addButton(content,button("ادامه و بررسی مجوز مکان",true));((Button)content.getChildAt(content.getChildCount()-1)).setOnClickListener(v->{state.prefs.edit().putBoolean("explained",true).apply();showPermissions();});
        Button exit=button("فعلاً نمی‌خواهم",false);addButton(content,exit);exit.setOnClickListener(v->finish());
    }
    private void showPermissions(){
        page="permissions";LinearLayout content=screen(true);heading(content,"اجازهٔ دسترسی به مکان");
        boolean foreground=state.foregroundPermission();
        content.addView(text(foreground?"مرحلهٔ اول انجام شده است. اکنون دسترسی مکان را روی «همیشه مجاز» قرار دهید.":"ابتدا اجازهٔ مکان را بدهید. سپس دسترسی در پس‌زمینه را جداگانه فعال می‌کنیم.",17,INK));gap(content,16);
        if(Build.VERSION.SDK_INT>=30)content.addView(text("در تنظیمات برنامه، «مجوزها ← مکان ← همیشه مجاز» را انتخاب کنید و به برنامه برگردید.",16,MUTED));
        Button allow=button(foreground?"بازکردن تنظیمات مجوز مکان":"درخواست مجوز مکان",true);addButton(content,allow);
        allow.setOnClickListener(v->{
            if(!state.foregroundPermission()){
                if(state.prefs.getBoolean("asked_location",false)&&!shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_COARSE_LOCATION)&&!shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION))openAppSettings();
                else {state.prefs.edit().putBoolean("asked_location",true).apply();requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION},101);}
            }else if(Build.VERSION.SDK_INT==29)requestPermissions(new String[]{Manifest.permission.ACCESS_BACKGROUND_LOCATION},102);
            else openAppSettings();
        });
        Button check=button("مجوز را فعال کردم؛ بررسی کن",false);addButton(content,check);check.setOnClickListener(v->{if(state.alwaysPermission()){if(state.registered())showHome();else showRegistration();}else Toast.makeText(this,"دسترسی «همیشه» هنوز فعال نیست.",Toast.LENGTH_LONG).show();});
        Button exit=button("بدون ارسال خارج شو",false);addButton(content,exit);exit.setOnClickListener(v->finish());
    }
    private void openAppSettings(){startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName())));}
    @Override public void onRequestPermissionsResult(int requestCode,String[] permissions,int[] results){super.onRequestPermissionsResult(requestCode,permissions,results);if(requestCode==101||requestCode==102){if(state.alwaysPermission()){if(state.registered())showHome();else showRegistration();}else showPermissions();}}
    private void showRegistration(){
        page="registration";LinearLayout content=screen(true);heading(content,"نام و شمارهٔ خود را وارد کنید");
        EditText server=field(content,"آدرس سامانه","https://tracking.example.com",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_URI);server.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);server.setTextDirection(View.TEXT_DIRECTION_LTR);server.setText(BuildConfig.DEFAULT_SERVER_URL);
        content.addView(text("این آدرس را مدیر پس از راه‌اندازی سرور اعلام می‌کند.",14,MUTED));gap(content,16);
        EditText name=field(content,"نام و نام خانوادگی","نام شما",InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_CAP_WORDS);
        EditText phone=field(content,"شماره موبایل","09123456789",InputType.TYPE_CLASS_PHONE);phone.setTextDirection(View.TEXT_DIRECTION_LTR);
        content.addView(text("برای شمارهٔ موبایل پیامک یا کد تأیید ارسال نمی‌شود.",14,MUTED));
        TextView error=text("",15,Color.rgb(164,49,39));content.addView(error);
        Button next=button("ادامه و تأیید ارسال",true);addButton(content,next);
        next.setOnClickListener(v->{
            String origin;
            try{origin=Api.validateServer(server.getText().toString());}catch(Exception e){error.setText(e.getMessage());return;}
            String person=name.getText().toString().trim(),mobile=phone.getText().toString().trim();
            if(person.length()<2||person.length()>80){error.setText("نام خود را وارد کنید.");return;}if(mobile.isEmpty()){error.setText("شماره موبایل را وارد کنید.");return;}
            if(!state.alwaysPermission()){showPermissions();return;}
            new AlertDialog.Builder(this).setTitle("رضایت به ارسال موقعیت")
                .setMessage("اطلاعات موقعیت شما حتی در پس‌زمینه برای مدیر سامانه ارسال خواهد شد. آیا مشکلی ندارید؟")
                .setPositiveButton("خیر، موافقم",(dialog,which)->{
                    next.setEnabled(false);error.setText("در حال ثبت اطلاعات…");
                    Api.IO.execute(()->{try{
                        JSONObject result=Api.request(origin,"/api/device/register",new JSONObject().put("name",person).put("phone",mobile).put("consent",true).put("disclosureVersion",1),null);
                        state.register(origin,result);runOnUiThread(()->{if(isFinishing())return;requestNotification();showHome();startTracking();});
                    }catch(Exception e){runOnUiThread(()->{next.setEnabled(true);error.setText(e instanceof Api.Failure?e.getMessage():"اتصال به سامانه انجام نشد؛ آدرس و اینترنت را بررسی کنید.");});}});
                }).setNegativeButton("بله، ارسال نکن",null).show();
        });
    }
    private void requestNotification(){if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED&&!state.prefs.getBoolean("asked_notification",false)){state.prefs.edit().putBoolean("asked_notification",true).apply();requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},103);}}
    private void showHome(){
        page="home";LinearLayout content=screen(false);TextView title=text("ردیابی افراد",22,INK);title.setTypeface(null,Typeface.BOLD);content.addView(title);content.addView(text(state.name()+" · "+state.phone(),15,MUTED));gap(content,10);
        sharingStatus=text("",16,INK);content.addView(sharingStatus);fixStatus=text("در انتظار موقعیت…",14,MUTED);content.addView(fixStatus);
        LinearLayout controls=new LinearLayout(this);controls.setGravity(Gravity.CENTER);controls.setOrientation(LinearLayout.HORIZONTAL);gap(content,8);
        sharingButton=button("",true);controls.addView(sharingButton,new LinearLayout.LayoutParams(0,dp(50),1));
        Button center=button("موقعیت من",false);LinearLayout.LayoutParams cp=new LinearLayout.LayoutParams(0,dp(50),1);cp.setMarginStart(dp(8));controls.addView(center,cp);content.addView(controls);
        sharingButton.setOnClickListener(v->{if(state.sharing()){TrackingService.stopSharing(this);updateHome();}else confirmResume();});center.setOnClickListener(v->{JSONObject point=currentLocation();if(point.has("latitude")&&map!=null)map.animateCamera(CameraUpdateFactory.newLatLngZoom(new LatLng(point.optDouble("latitude"),point.optDouble("longitude")),16));else Toast.makeText(this,"هنوز موقعیتی از گوشی دریافت نشده است.",Toast.LENGTH_LONG).show();});
        mapError=text("",14,Color.rgb(164,49,39));content.addView(mapError);
        mapView=new MapView(this);root.addView(mapView,new LinearLayout.LayoutParams(-1,0,1));mapView.onCreate(null);
        if(started)mapView.onStart();if(resumed)mapView.onResume();
        mapView.getMapAsync(m->{map=m;map.moveCamera(CameraUpdateFactory.newLatLngZoom(new LatLng(32.4279,53.688),4.5));map.setStyle("https://tiles.openfreemap.org/styles/liberty",style->{mapError.setText("");updateHome();});});
        mapView.addOnDidFailLoadingMapListener(error->{mapError.setText("نقشه بارگذاری نشد؛ اتصال اینترنت را بررسی کنید.");});
        LinearLayout footer=new LinearLayout(this);footer.setOrientation(LinearLayout.VERTICAL);footer.setPadding(dp(20),dp(8),dp(20),dp(8));footer.addView(text("نمایش نقشه: OpenFreeMap · داده‌ها: OpenStreetMap",12,MUTED));root.addView(footer);
        if(state.sharing()&&!state.alwaysPermission())TrackingService.stopSharing(this);
        if(resumed)listenToOwnLocation();handler.removeCallbacks(refresh);handler.post(refresh);updateHome();
    }
    private JSONObject currentLocation(){JSONObject point=state.location();return displayLocation!=null&&displayLocation.optLong("capturedAt")>point.optLong("capturedAt")?displayLocation:point;}
    private void updateHome(){
        if(!"home".equals(page)||sharingStatus==null)return;
        if(state.sharing()&&!state.alwaysPermission())TrackingService.stopSharing(this);
        sharingStatus.setText(state.sharing()?state.prefs.getString("status","ارسال موقعیت فعال است."):
            state.pendingRevoke()?"ارسال متوقف است؛ پس از اتصال، موقعیت قبلی از پنل مدیر پاک می‌شود.":"ارسال موقعیت متوقف است. فقط خودتان موقعیت را می‌بینید.");
        sharingButton.setText(state.sharing()?"توقف ارسال":"شروع ارسال");
        JSONObject point=currentLocation();
        if(point.has("latitude")){
            String time=DateFormat.getTimeInstance(DateFormat.MEDIUM,new Locale("fa")).format(new Date(point.optLong("capturedAt")));
            fixStatus.setText("زمان موقعیت: "+time+" · دقت: "+Math.round(point.optDouble("accuracy"))+" متر");
            if(map!=null){LatLng position=new LatLng(point.optDouble("latitude"),point.optDouble("longitude"));if(marker==null)marker=map.addMarker(new MarkerOptions().position(position).title("موقعیت من"));else marker.setPosition(position);if(!centered){centered=true;map.moveCamera(CameraUpdateFactory.newLatLngZoom(position,15));}}
        }else fixStatus.setText(state.locationEnabled()?"در انتظار موقعیت گوشی…":"مکان‌یابی گوشی خاموش است؛ آن را روشن کنید.");
    }
    private void confirmResume(){
        if(!state.alwaysPermission()){showPermissions();return;}
        new AlertDialog.Builder(this).setTitle("شروع دوبارهٔ ارسال")
            .setMessage("موقعیت شما حتی در پس‌زمینه برای مدیر سامانه ارسال خواهد شد. آیا مشکلی ندارید؟")
            .setPositiveButton("خیر، موافقم",(d,w)->{sharingButton.setEnabled(false);Api.IO.execute(()->{try{
                Api.flushRevocation(this);Api.device(this,"/api/device/consent",new JSONObject().put("consent",true).put("disclosureVersion",1));
                state.prefs.edit().putBoolean("sharing",true).putBoolean("pending_revoke",false).commit();
                runOnUiThread(()->{sharingButton.setEnabled(true);requestNotification();startTracking();updateHome();});
            }catch(Exception e){runOnUiThread(()->{sharingButton.setEnabled(true);new AlertDialog.Builder(this).setMessage("شروع ارسال انجام نشد؛ اتصال به سامانه را بررسی کنید.").setPositiveButton("باشه",null).show();});}});})
            .setNegativeButton("بله، ارسال نکن",null).show();
    }
    private void startTracking(){if(state.sharing()&&state.alwaysPermission()){try{startForegroundService(new Intent(this,TrackingService.class));}catch(RuntimeException e){state.status("برای شروع ارسال دوباره تلاش کنید.");}}}
    private void listenToOwnLocation(){
        if(!state.foregroundPermission())return;
        try{for(String provider:new String[]{LocationManager.GPS_PROVIDER,LocationManager.NETWORK_PROVIDER})if(locations.getAllProviders().contains(provider))locations.requestLocationUpdates(provider,10000,0,this,Looper.getMainLooper());}catch(SecurityException ignored){}
    }
    @Override public void onLocationChanged(Location location){try{displayLocation=new JSONObject().put("latitude",location.getLatitude()).put("longitude",location.getLongitude()).put("accuracy",location.getAccuracy()).put("capturedAt",location.getTime());updateHome();}catch(Exception ignored){}}
    @Override public void onProviderEnabled(String provider){updateHome();}
    @Override public void onProviderDisabled(String provider){updateHome();}
    @Override public void onStatusChanged(String provider,int status,Bundle extras){}
    @Override public void onStart(){super.onStart();started=true;if(mapView!=null)mapView.onStart();}
    @Override public void onResume(){super.onResume();resumed=true;if(mapView!=null)mapView.onResume();
        if("permissions".equals(page)&&state.alwaysPermission()){if(state.registered())showHome();else showRegistration();}
        if("home".equals(page)){listenToOwnLocation();if(state.sharing())startTracking();handler.removeCallbacks(refresh);handler.post(refresh);}
        if(state.pendingRevoke())Api.IO.execute(()->{try{Api.flushRevocation(this);}catch(Exception ignored){ConsentSyncJob.schedule(this);}});
    }
    @Override public void onPause(){if(mapView!=null)mapView.onPause();resumed=false;if(locations!=null)locations.removeUpdates(this);handler.removeCallbacks(refresh);super.onPause();}
    @Override public void onStop(){if(mapView!=null)mapView.onStop();started=false;super.onStop();}
    @Override public void onDestroy(){if(mapView!=null)mapView.onDestroy();handler.removeCallbacksAndMessages(null);super.onDestroy();}
    @Override public void onLowMemory(){super.onLowMemory();if(mapView!=null)mapView.onLowMemory();}
}
