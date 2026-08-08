import { autoinject, bindable } from 'aurelia-framework';
import { GreeterService } from './greeter';

@autoinject
export class Home {
  @bindable name = 'World';

  constructor(private greeter: GreeterService) {}

  greet(): string {
    return this.greeter.greet(this.name);
  }
}
