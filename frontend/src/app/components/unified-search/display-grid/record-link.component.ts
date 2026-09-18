import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * A record's name as the link to the record, or as plain text where it has no page of its own.
 *
 * Angular sanitises a bound `href`, so a `javascript:` target from the index cannot fire; an
 * in-app target routes instead of reloading the shell.
 */
@Component({
  selector: 'app-record-link',
  standalone: true,
  imports: [NgTemplateOutlet, RouterLink],
  templateUrl: './record-link.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class RecordLinkComponent {
  href = input<string | undefined>();
  /** Leaves the app — a file download, say — so it gets a real anchor and its own tab. */
  external = input(false);
  linkClass = input('');
  title = input<string | undefined>();
}
