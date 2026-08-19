/**
 * /connect表示時に記録するbrowser history起点(sessionStorage)のキー名。
 * OAuth成功ページの「Even Calendarへ戻る」ボタンが history.go(-N) のNを算出する際、
 * /connectで記録した起点を読み出すため、productConnectPage.ts(書き込み側)と
 * productOAuth.ts(読み出し側)の両方で同じキー名を使う必要がある。
 */
export const PRODUCT_HISTORY_RETURN_MARKER_STORAGE_KEY = 'evenCalendarHistoryMarker';
