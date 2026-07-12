import { DashboardService } from './../../core/services/dashboard.service';
import { AuthenticationService, IAuthorizationToken } from './../../core/services/authentication.service';
import { SettingsService } from './../../core/services/settings.service';
import { AfterViewInit, Component, ElementRef, effect, inject, input, OnDestroy, viewChild, untracked } from '@angular/core';
import { SafePipe } from "../../core/pipes/safe.pipe";
import { generateSwipeScript } from '../../core/utils/iframe-inputs-inject.utils';
import { WidgetRuntimeDirective } from '../../core/directives/widget-runtime.directive';
import { IWidgetSvcConfig } from '../../core/interfaces/widgets-interface';
import { AppService, ITheme } from '../../core/services/app-service';
import { toSignal } from '@angular/core/rxjs-interop';
import { connectExtension, ExtensionClient, windowPort } from 'signalk-plotterext-bus/extension';


@Component({
  selector: 'widget-freeboardsk',
  templateUrl: './widget-freeboardsk.component.html',
  styleUrl: './widget-freeboardsk.component.scss',
  imports: [SafePipe]
})
export class WidgetFreeboardskComponent implements AfterViewInit, OnDestroy {
  public id = input<string>();
  public type = input<string>();
  public theme = input<ITheme | null>();

  public disableWidgetShell = input<boolean>(false);
  public swipeDisabled = input<boolean>(false);

  private readonly runtime = inject(WidgetRuntimeDirective, { optional: true });
  private readonly appSettings = inject(SettingsService);
  private readonly app = inject(AppService);
  private readonly auth = inject(AuthenticationService);
  protected readonly dashboard = inject(DashboardService);

  protected iframe = viewChild.required<ElementRef<HTMLIFrameElement>>('freeboardSkIframe');

  private readonly authToken = toSignal<IAuthorizationToken | null>(this.auth.authToken$, { initialValue: null });

  private viewReady = false;
  // Plotter Extensions bus client: KIP drives the embedded Freeboard as a
  // caller (the "embedding host") over the negotiated bus, in place of the
  // legacy night-mode postMessage bridge.
  private busClient: ExtensionClient | null = null;
  public widgetUrl: string | null = null;
  protected widgetUrlSafe = '';
  public static readonly DEFAULT_CONFIG: IWidgetSvcConfig = {};

  constructor() {
    window.addEventListener('message', this.handleIframeGesture);

    effect(() => {
      const token = this.authToken();

      untracked(() => {
        const loginToken = token?.token;
        const signalkBaseUrl = this.appSettings.signalkUrl?.url;
        this.widgetUrl = signalkBaseUrl
          ? (loginToken
            ? `${signalkBaseUrl}/@signalk/freeboard-sk/?token=${loginToken}`
            : `${signalkBaseUrl}/@signalk/freeboard-sk/`)
          : null;
        this.widgetUrlSafe = this.widgetUrl ?? '';
      });
    });

    effect(() => {
      const nightModeEnabled = this.app.isNightMode();

      untracked(() => this.applyNightMode(nightModeEnabled));
    });
  }

  ngAfterViewInit(): void {
    this.viewReady = true;

    // Ensure we mark the iframe loaded AND inject gestures.
    try {
      this.iframe().nativeElement.onload = () => {
        this.connectBus();
        this.injectSwipeScript();
      };
    } catch {
      /* ignore */
    }
  }

  // Connect to the embedded Freeboard over the Plotter Extensions bus as the
  // caller. KIP is the parent, so the port targets the child iframe's window;
  // the origin is pinned to Freeboard's own origin (a cross-origin embedder is
  // refused by the host). Reconnects cleanly if the iframe reloads.
  private async connectBus(): Promise<void> {
    this.busClient?.close();
    this.busClient = null;

    const target = this.iframe()?.nativeElement?.contentWindow;
    if (!target) return;

    const origin = this.getExpectedIframeOrigin();
    try {
      const client = await connectExtension({
        port: windowPort(target, { origin: origin ?? '*' }),
        id: 'kip'
      });
      // Guard against a stale connection if the iframe reloaded mid-handshake.
      if (this.iframe()?.nativeElement?.contentWindow !== target) {
        client.close();
        return;
      }
      this.busClient = client;
      // Match the legacy bridge: unconditionally take manual control of night
      // mode on load (do not follow the server), regardless of red-night-mode.
      // The current enabled state is not pushed here — as before, it follows on
      // the next isNightMode() change.
      this.takeControlOfNightMode();
    } catch (err) {
      console.warn('[FSK Widget] Plotter Extensions bus handshake failed:', err);
    }
  }

  // Take manual control of Freeboard's night mode (do not follow the server) —
  // the bus equivalent of the legacy `settings.autoNightMode = false`, sent once
  // on connect regardless of the red-night-mode setting.
  private takeControlOfNightMode(): void {
    if (!this.busClient?.hasCapability('nightMode')) return;
    this.busClient.nightMode
      .set({ auto: false })
      .catch((err) => console.warn('[FSK Widget] nightMode.set failed:', err));
  }

  // Drive Freeboard's night mode over the bus, honouring KIP's red-night-mode
  // setting — the bus equivalent of the legacy `commands.nightModeEnable`.
  private applyNightMode(enabled: boolean): void {
    if (!this.busClient?.hasCapability('nightMode')) return;
    if (!this.appSettings.getRedNightMode()) return;
    this.busClient.nightMode
      .set({ enabled })
      .catch((err) => console.warn('[FSK Widget] nightMode.set failed:', err));
  }

  private injectSwipeScript() {
    if (this.swipeDisabled()) return;
    const iframeWindow = this.iframe().nativeElement.contentWindow;
    const iframeDocument = this.iframe().nativeElement.contentDocument;
    if (!iframeDocument || !iframeWindow) {
      console.error('[FSK Widget] Iframe contentDocument or contentWindow is undefined.');
      return;
    }
    try {
      const id = `kip-gesture-inject-${this.id()}`;
      if (iframeDocument.getElementById(id)) return;
      const scriptText = generateSwipeScript({ instanceId: this.id() });
      const script = iframeDocument.createElement('script');
      script.id = id;
      script.textContent = scriptText;
      iframeDocument.body.appendChild(script);
    } catch (e) {
      console.warn('[FSK Widget] Failed to inject swipe script into iframe:', e);
    }
  }

  private handleIframeGesture = (event: MessageEvent) => {
    if (!event.data) return;

    // Only accept messages originating from this widget's iframe.
    if (!this.viewReady) return;
    let iframeWindow: Window | null = null;
    try {
      iframeWindow = this.iframe()?.nativeElement?.contentWindow ?? null;
    } catch {
      iframeWindow = null;
    }
    if (!iframeWindow || event.source !== iframeWindow) return;

    const expectedOrigin = this.getExpectedIframeOrigin();
    if (expectedOrigin && event.origin !== expectedOrigin) return;

    const instanceId = this.id();
    if (event.data.gesture && event.data.eventData?.instanceId === instanceId) {
      switch (event.data.gesture) {
        case 'swipeup':
          if (this.dashboard.isDashboardStatic()) this.dashboard.navigateToPreviousDashboard();
          break;
        case 'swipedown':
          if (this.dashboard.isDashboardStatic()) this.dashboard.navigateToNextDashboard();
          break;
        case 'swipeleft':
          window.document.dispatchEvent(new Event('openLeftSidenav', { bubbles: true, cancelable: true }));
          break;
        case 'swiperight':
          window.document.dispatchEvent(new Event('openRightSidenav', { bubbles: true, cancelable: true }));
          break;
      }
    }
    if (event.data.type === 'keydown' && event.data.keyEventData?.instanceId === instanceId) {
      const { key, ctrlKey, shiftKey } = event.data.keyEventData;
      const keyboardEvent = new KeyboardEvent('keydown', { key, ctrlKey, shiftKey, bubbles: true, cancelable: true });
      document.dispatchEvent(keyboardEvent);
    }
  };

  private getExpectedIframeOrigin(): string | null {
    const candidate = this.widgetUrl || this.appSettings.signalkUrl?.url;
    if (!candidate) return null;
    try {
      return new URL(candidate).origin;
    } catch {
      return null;
    }
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.handleIframeGesture);
    this.busClient?.close();
    this.busClient = null;
    if (this.iframe) {
      try { this.iframe().nativeElement.onload = null; } catch (err) { void err; }
      try {
        const iframeDoc = this.iframe()?.nativeElement.contentDocument;
        if (iframeDoc) {
          const id = `kip-gesture-inject-${this.id()}`;
          const existing = iframeDoc.getElementById(id);
          if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        }
      } catch { /* ignore cross-origin */ }
    }
  }
}
