package io.ionic.starter;

import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.pdf.PdfDocument;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintDocumentInfo;
import android.print.PrintManager;
import android.print.pdf.PrintedPdfDocument;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.FileOutputStream;
import java.io.IOException;

@CapacitorPlugin(name = "OfflinePrint")
public class OfflinePrintPlugin extends Plugin {
    private android.webkit.WebView documentView;

    @PluginMethod
    public void printHtml(PluginCall call) {
        String html = call.getString("html", "");
        String title = call.getString("title", "AcadCheck Document");
        if (html.isEmpty() || html.length() > 5000000) { call.reject("Invalid print document"); return; }
        getActivity().runOnUiThread(() -> {
            if (documentView != null) { call.reject("Finish the current document print first."); return; }
            android.webkit.WebView view = new android.webkit.WebView(getActivity());
            documentView = view;
            view.getSettings().setJavaScriptEnabled(false);
            view.setWebViewClient(new android.webkit.WebViewClient() {
                private boolean opened;
                @Override public void onPageFinished(android.webkit.WebView webView, String url) {
                    if (opened) return;
                    opened = true;
                    try {
                        PrintManager manager = (PrintManager) getContext().getSystemService(android.content.Context.PRINT_SERVICE);
                        if (manager == null) throw new IllegalStateException("Android print service is unavailable");
                        PrintDocumentAdapter delegate = webView.createPrintDocumentAdapter(title);
                        PrintDocumentAdapter adapter = new PrintDocumentAdapter() {
                            @Override public void onStart() { delegate.onStart(); }
                            @Override public void onLayout(PrintAttributes oldAttr, PrintAttributes newAttr,
                                    CancellationSignal signal, LayoutResultCallback callback, Bundle extras) {
                                delegate.onLayout(oldAttr, newAttr, signal, callback, extras);
                            }
                            @Override public void onWrite(android.print.PageRange[] pages, ParcelFileDescriptor destination,
                                    CancellationSignal signal, WriteResultCallback callback) {
                                delegate.onWrite(pages, destination, signal, callback);
                            }
                            @Override public void onFinish() {
                                delegate.onFinish(); view.destroy(); documentView = null;
                            }
                        };
                        PrintAttributes attributes = new PrintAttributes.Builder()
                            .setMediaSize(new PrintAttributes.MediaSize("LONG_BOND", "Long bond 8.5 x 13", 8500, 13000))
                            .setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                            .setColorMode(PrintAttributes.COLOR_MODE_COLOR).build();
                        manager.print(title, adapter, attributes);
                        call.resolve();
                    } catch (Exception error) { view.destroy(); documentView = null; call.reject("Could not open document printing", error); }
                }
            });
            view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        });
    }

    @Override protected void handleOnDestroy() {
        if (documentView != null) { documentView.destroy(); documentView = null; }
    }

    @PluginMethod
    public void printScore(PluginCall call) {
        String requestedScore = call.getString("scoreText", "0/50");
        String scoreText = validScoreText(requestedScore) ? requestedScore : "0/50";
        String studentName = call.getString("studentName", "Student");
        String jobName = "AcadCheck " + (studentName == null ? "Student" : studentName) + " " + scoreText;

        getActivity().runOnUiThread(() -> {
            try {
                PrintManager manager = (PrintManager) getContext().getSystemService(android.content.Context.PRINT_SERVICE);
                if (manager == null) {
                    call.reject("Android print service is unavailable");
                    return;
                }
                PrintDocumentAdapter adapter = scoreAdapter(jobName, scoreText);
                PrintAttributes attributes = new PrintAttributes.Builder()
                    .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                    .setColorMode(PrintAttributes.COLOR_MODE_COLOR)
                    .build();
                manager.print(jobName, adapter, attributes);
                JSObject result = new JSObject();
                result.put("success", true);
                result.put("jobName", jobName);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Could not open Android print service", error);
            }
        });
    }

    private boolean validScoreText(String value) {
        if (value == null || !value.matches("\\d{1,3}/\\d{1,3}")) return false;
        String[] parts = value.split("/");
        int score = Integer.parseInt(parts[0]);
        int total = Integer.parseInt(parts[1]);
        return total >= 1 && total <= 500 && score <= total;
    }

    private PrintDocumentAdapter scoreAdapter(String jobName, String scoreText) {
        return new PrintDocumentAdapter() {
            private PrintAttributes attributes;

            @Override
            public void onLayout(
                PrintAttributes oldAttributes,
                PrintAttributes newAttributes,
                CancellationSignal cancellationSignal,
                LayoutResultCallback callback,
                Bundle extras
            ) {
                if (cancellationSignal.isCanceled()) {
                    callback.onLayoutCancelled();
                    return;
                }
                attributes = newAttributes;
                PrintDocumentInfo info = new PrintDocumentInfo.Builder(jobName)
                    .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
                    .setPageCount(1)
                    .build();
                callback.onLayoutFinished(info, !newAttributes.equals(oldAttributes));
            }

            @Override
            public void onWrite(
                android.print.PageRange[] pages,
                ParcelFileDescriptor destination,
                CancellationSignal cancellationSignal,
                WriteResultCallback callback
            ) {
                if (cancellationSignal.isCanceled()) {
                    callback.onWriteCancelled();
                    return;
                }
                PrintedPdfDocument document = new PrintedPdfDocument(getContext(), attributes);
                try {
                    PdfDocument.Page page = document.startPage(0);
                    Canvas canvas = page.getCanvas();
                    android.graphics.Rect content = page.getInfo().getContentRect();
                    PrintAttributes.Resolution resolution = attributes.getResolution();
                    float dpi = resolution == null ? 300f : resolution.getHorizontalDpi();
                    float centerX = content.right - (0.32f + 0.42f) * dpi;
                    float centerY = content.bottom - (0.36f + 1.565f) * dpi;
                    Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
                    paint.setColor(Color.RED);
                    paint.setStyle(Paint.Style.STROKE);
                    paint.setStrokeWidth(Math.max(1.2f, dpi * 0.012f));
                    paint.setTextSize(dpi * 0.22f);
                    paint.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
                    paint.setTextAlign(Paint.Align.CENTER);
                    canvas.save();
                    canvas.rotate(90f, centerX, centerY);
                    float baseline = centerY - (paint.ascent() + paint.descent()) / 2f;
                    canvas.drawText(scoreText, centerX, baseline, paint);
                    canvas.restore();
                    document.finishPage(page);
                    document.writeTo(new FileOutputStream(destination.getFileDescriptor()));
                    callback.onWriteFinished(new android.print.PageRange[] { android.print.PageRange.ALL_PAGES });
                } catch (IOException error) {
                    callback.onWriteFailed(error.getMessage());
                } finally {
                    document.close();
                }
            }
        };
    }
}
