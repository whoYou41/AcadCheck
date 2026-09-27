package io.ionic.starter;

/** Physical long-bond layout, measured on the upright full sheet in inches.
 * The user loads the bottom/QR edge first, so print coordinates and glyphs
 * both need a 180-degree transformation. The right-hand form is the target.
 */
public final class ScorePrintLayout {
    public static final int DPI = 360;
    public static final int PAGE_WIDTH = 3060, PAGE_HEIGHT = 4680; // 8.5 x 13 inches
    public static final int MARGIN = 42;
    public static final int LABEL_WIDTH = Math.round(0.95f * DPI);
    public static final int LABEL_HEIGHT = Math.round(0.30f * DPI);
    public static final int UPRIGHT_LEFT = Math.round(7.05f * DPI);
    public static final int UPRIGHT_TOP = Math.round(2.00f * DPI);
    public static final int ROTATION_DEGREES = 180;
    public static final int LEFT = PAGE_WIDTH - UPRIGHT_LEFT - LABEL_WIDTH - MARGIN;
    public static final int TOP = PAGE_HEIGHT - UPRIGHT_TOP - LABEL_HEIGHT - MARGIN;
    private ScorePrintLayout() {}
}
