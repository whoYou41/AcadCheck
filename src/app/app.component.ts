import { Component } from '@angular/core';
import { IonApp, IonRouterOutlet } from '@ionic/angular/standalone';
import { NavMenuComponent } from './components/nav-menu/nav-menu.component';
import { PageGuidanceComponent } from './components/page-guidance/page-guidance.component';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  imports: [IonApp, IonRouterOutlet, NavMenuComponent, PageGuidanceComponent],
})
export class AppComponent {}
