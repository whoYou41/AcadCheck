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
    public static final int QUESTION_ROW_TOP = Math.round(3.3556f * DPI);
    public static final int QUESTION_ROW_STEP = Math.round(0.2306f * DPI);
    public static final int QUESTION_MARK_SIZE = Math.round(0.10f * DPI);
    public static final int[] QUESTION_COLUMN_X = {
        Math.round(0.8333f * DPI), Math.round(2.8f * DPI),
        Math.round(4.6667f * DPI), Math.round(6.8889f * DPI)
    };
    public static int questionX(int questionNumber) {
        int column = questionNumber <= 25 ? 0 : 1;
        return QUESTION_COLUMN_X[column + 2];
    }
    public static int questionY(int questionNumber) {
        return QUESTION_ROW_TOP + ((questionNumber - 1) % 25) * QUESTION_ROW_STEP;
    }
    public static final int LEFT = PAGE_WIDTH - UPRIGHT_LEFT - LABEL_WIDTH - MARGIN;
    public static final int TOP = PAGE_HEIGHT - UPRIGHT_TOP - LABEL_HEIGHT - MARGIN;
    private ScorePrintLayout() {}
}
