import { describe, expect, it } from 'vitest';
import { formatCloudBody } from '../src/content/format';

describe('managed content formatting',()=>{
  it('keeps plain text as paragraphs',()=>{
    expect(formatCloudBody('first\n\nsecond')).toEqual([
      {kind:'paragraph',text:'first'},
      {kind:'paragraph',text:'second'},
    ]);
  });

  it('renders string arrays as lists',()=>{
    expect(formatCloudBody(['A','B'])).toEqual([{kind:'list',items:['A','B']}]);
  });

  it('preserves arbitrary category names without defining content',()=>{
    expect(formatCloudBody({
      開発:['A','B'],
      音楽:'C',
    })).toEqual([
      {kind:'section',title:'開発',children:[{kind:'list',items:['A','B']}]},
      {kind:'section',title:'音楽',children:[{kind:'paragraph',text:'C'}]},
    ]);
  });

  it('does not interpret HTML strings as markup',()=>{
    expect(formatCloudBody('<script>alert(1)</script>')).toEqual([
      {kind:'paragraph',text:'<script>alert(1)</script>'},
    ]);
  });
});
