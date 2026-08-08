import { Component } from '@angular/core';
import { IGreeter } from './greeter.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
})
export class AppComponent {
  title = 'sample-angular-app';

  // Injected by interface type, not the concrete class — the real-world pattern that made
  // graph_get_callers silently return empty for a heavily-called concrete method, since the
  // TypeChecker resolves `this.greeter.greet(...)` to IGreeter.greet, never GreeterService.greet
  // directly (see graphBuilder.ts's emitInterfaceMemberImplementations).
  constructor(private greeter: IGreeter) {}

  greetTitle(): string {
    return this.greeter.greet(this.title);
  }
}
