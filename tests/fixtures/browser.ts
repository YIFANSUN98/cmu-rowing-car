import { expect, type Page } from '@playwright/test';
import { makeDemo } from '../../src/domain/scenarios';
import type { Dataset } from '../../src/domain/types';
import type { FileKind } from '../../src/domain/validation';
import { inputWorkbook, workbookBytes } from './workbooks';

export function browserData() {
  const data = makeDemo({ people: 6, driverCount: 2 });
  const date = data.attendance[0].date;
  data.attendance = data.attendance.filter((a) => a.date === date);
  data.availability = data.availability
    .filter((a) => a.date === date)
    .map((a) => ({ ...a, source: 'confirmed' }));
  delete data.scenario;
  return data;
}

export async function uploadWorkbook(
  page: Page,
  kind: FileKind,
  book: ReturnType<typeof inputWorkbook>,
  name = `${kind}.xlsx`,
) {
  await page.getByLabel('Upload Excel files', { exact: true }).setInputFiles({
    name,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(workbookBytes(book)),
  });
  await expect(page.getByText('Reading and validating your files…', { exact: true })).toBeHidden();
}

export async function uploadInputs(page: Page, data: Dataset) {
  await page.getByLabel('Upload Excel files', { exact: true }).setInputFiles(
    (['availability', 'members', 'attendance'] as const).map((kind) => ({
      name: `${kind === 'availability' ? 'drivers' : kind}.xlsx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(workbookBytes(inputWorkbook(data, kind))),
    })),
  );
  await expect(page.getByText('Reading and validating your files…', { exact: true })).toBeHidden();
}

// Exercise the production HTTP adapter without real service calls or credentials.
export async function installTomTomFixture(
  page: Page,
  behavior: 'success' | 'error' | 'pending' | 'quota' | 'route-quota' = 'success',
) {
  await page.route('https://api.waterdata.usgs.gov/**', (route) =>
    route.fulfill({
      json: {
        features: [
          {
            properties: {
              monitoring_location_id: 'USGS-03049500',
              parameter_code: '00060',
              time: '2026-09-21T11:45:00Z',
              value: '21700',
              unit_of_measure: 'ft^3/s',
            },
          },
        ],
      },
    }),
  );
  await page.route('https://api.weather.gov/**', (route) =>
    route.fulfill({
      json: {
        properties: {
          timestamp: '2026-09-21T11:53:00Z',
          textDescription: 'Partly Cloudy',
          temperature: { value: 17, unitCode: 'wmoUnit:degC' },
          windSpeed: { value: 8, unitCode: 'wmoUnit:km_h-1' },
        },
      },
    }),
  );
  await page.route('https://api.tomtom.com/map/**', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        'base64',
      ),
    }),
  );
  await page.clock.setFixedTime(new Date('2026-09-21T12:00:00Z'));
  await page.addInitScript((behavior) => {
    const calls: string[] = [];
    (window as any).__tomtomCalls = calls;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname !== 'api.tomtom.com') return nativeFetch(input, init);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const kind = url.pathname.includes('/geocode/')
        ? 'geocode'
        : url.pathname.includes('/batch/sync/') && !body.batchItems?.[0]?.post
          ? 'matrix'
          : 'route';
      calls.push(kind);
      if ((window as any).__tomtomQuota && kind === 'route')
        return new Response('{}', { status: 429 });
      if (behavior === 'error') return new Response('{}', { status: 403 });
      if (behavior === 'quota' || (behavior === 'route-quota' && kind === 'route'))
        return new Response('{}', { status: 429 });
      if (behavior === 'pending')
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            { once: true },
          );
        });
      const respond = (data: unknown) =>
        new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      if (kind === 'geocode') {
        const address = decodeURIComponent(url.pathname.split('/geocode/')[1]);
        const offset = [...address].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 1000;
        return respond({
          results: [
            { type: 'Point Address', position: { lat: 40.4 + offset / 100000, lon: -79.9 } },
          ],
        });
      }
      if (kind === 'matrix')
        return respond({
          batchItems: body.batchItems.map(() => ({
            statusCode: 200,
            response: { routes: [{ summary: { travelTimeInSeconds: 60, lengthInMeters: 500 } }] },
          })),
        });
      const responseFor = (url: URL, body: any) => {
        const start = Date.parse(url.searchParams.get('departAt')!);
        const points = url.pathname
          .split('/calculateRoute/')[1]
          .split('/json')[0]
          .split(':')
          .map((p) => {
            const [latitude, longitude] = p.split(',').map(Number);
            return { latitude, longitude };
          });
        let time = start;
        const legs = body.legs.map((leg: any, i: number) => {
          const departureTime = new Date(time).toISOString();
          time += 60000;
          const arrivalTime = new Date(time).toISOString();
          const boarding = leg.routeStop.pauseTimeInSeconds;
          time += boarding * 1000;
          return {
            summary: {
              departureTime,
              arrivalTime,
              travelTimeInSeconds: 60,
              lengthInMeters: 500,
              userDefinedPauseTimeInSeconds: boarding,
            },
            points: [
              points[i],
              {
                latitude: (points[i].latitude + points[i + 1].latitude) / 2,
                longitude: points[i].longitude + 0.001,
              },
              points[i + 1],
            ],
          };
        });
        return {
          routes: [
            {
              summary: {
                departureTime: new Date(start).toISOString(),
                arrivalTime: new Date(time).toISOString(),
                travelTimeInSeconds: (time - start) / 1000,
                lengthInMeters: legs.length * 500,
              },
              legs,
            },
          ],
        };
      };
      return respond(
        body.batchItems
          ? {
              batchItems: body.batchItems.map((item: any) => ({
                statusCode: 200,
                response: responseFor(new URL(item.query, 'https://fixture.invalid'), item.post),
              })),
            }
          : responseFor(url, body),
      );
    };
  }, behavior);
}
