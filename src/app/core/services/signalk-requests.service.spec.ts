import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ISignalKDeltaMessage } from '../interfaces/signalk-interfaces';
import { AuthenticationService } from './authentication.service';
import { SignalKDeltaService } from './signalk-delta.service';
import { SignalkRequestsService } from './signalk-requests.service';
import { ToastService } from './toast.service';

describe('SignalkRequestsService', () => {
  let requestUpdates$: Subject<ISignalKDeltaMessage>;
  let publishedMessages: unknown[];
  let toastMessages: Array<{ message: string; duration?: number; severity?: string }>;
  let isLoggedIn$: Subject<boolean>;

  beforeEach(() => {
    requestUpdates$ = new Subject<ISignalKDeltaMessage>();
    publishedMessages = [];
    toastMessages = [];
    isLoggedIn$ = new Subject<boolean>();

    TestBed.configureTestingModule({
      providers: [
        SignalkRequestsService,
        {
          provide: SignalKDeltaService,
          useValue: {
            subscribeRequestUpdates: () => requestUpdates$.asObservable(),
            publishDelta: (msg: unknown) => publishedMessages.push(msg),
          },
        },
        {
          provide: ToastService,
          useValue: {
            show: (message: string, duration?: number, _persist?: boolean, severity?: string) => {
              toastMessages.push({ message, duration, severity });
            },
          },
        },
        {
          provide: AuthenticationService,
          useValue: {
            isLoggedIn$: isLoggedIn$.asObservable(),
            setDeviceAccessToken: () => undefined,
          },
        },
      ],
    });
  });

  it('should be created', () => {
    const service: SignalkRequestsService = TestBed.inject(SignalkRequestsService);
    expect(service).toBeTruthy();
  });

  it('includes request context when a PUT request times out with 504', () => {
    const service: SignalkRequestsService = TestBed.inject(SignalkRequestsService);

    const requestId = service.putRequest('self.electrical.switches.sanitation.vacuum.master.enabled', true, 'widget-123');

    expect(requestId).toBeTruthy();
    expect(publishedMessages).toHaveLength(1);

    requestUpdates$.next({
      requestId,
      statusCode: 504,
    });

    expect(toastMessages).toHaveLength(1);
    expect(toastMessages[0].severity).toBe('error');
    expect(toastMessages[0].message).toContain('Request timed out (504)');
    expect(toastMessages[0].message).toContain('path=self.electrical.switches.sanitation.vacuum.master.enabled');
    expect(toastMessages[0].message).toContain('origin=widget-123');
    expect(toastMessages[0].message).toContain('value=true');
  });
});
