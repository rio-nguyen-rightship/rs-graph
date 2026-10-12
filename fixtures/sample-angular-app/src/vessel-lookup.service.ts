import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

// Exercises HttpClientEnrichment's INVOKES_ROUTE extraction: a real Angular HttpClient call with
// an interpolated URL segment, proving the edge gets emitted and that the caller's own local
// variable name ({vesselId}) doesn't need to match a route's declared parameter name for the
// normalized key to come out right (see routeKey.ts's normalizeRouteTemplate).
@Injectable({ providedIn: 'root' })
export class VesselLookupService {
  constructor(private http: HttpClient) {}

  lookup(vesselId: number) {
    return this.http.get(`api/v1/Vessel/${vesselId}`);
  }
}
