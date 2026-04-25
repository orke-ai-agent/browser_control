#!/usr/bin/env ruby
# frozen_string_literal: true

require 'fileutils'
require 'json'
require 'net/http'
require 'optparse'
require 'time'
require 'uri'
require 'yaml'

class TrelloActiveTasksExporter
  ACTIVE_LISTS = ['TO DO', 'IN PROGRESS'].freeze
  STAGES = ['CORE', 'MVP'].freeze
  LAYERS = ['MOB', 'BE', 'WEB', 'OPS'].freeze

  def initialize(options)
    @options = options
    @key = options.fetch(:key)
    @token = options.fetch(:token)
    @log_path = options.fetch(:log_path)
    FileUtils.mkdir_p(File.dirname(@log_path))
  end

  def run
    board = request(:get, "/boards/#{@options.fetch(:board_id)}", fields: 'id,name,shortLink,url')
    labels = request(:get, "/boards/#{@options.fetch(:board_id)}/labels", fields: 'id,name,color')
    label_name_by_id = labels.each_with_object({}) do |label, acc|
      next if label['name'].to_s.strip.empty?

      acc[label['id']] = label['name']
    end

    board_lists = request(:get, "/boards/#{@options.fetch(:board_id)}/lists", fields: 'id,name,pos,closed')
    active_lists = board_lists.select { |list| ACTIVE_LISTS.include?(list['name']) }
    list_index = active_lists.map { |list| [list['id'], list] }.to_h

    cards = active_lists.flat_map do |list|
      request(:get, "/lists/#{list['id']}/cards", fields: 'id,name,pos,idLabels,desc').map do |card|
        card.merge('__list_name' => list['name'], '__list_pos' => list['pos'])
      end
    end

    cards.sort_by! { |card| [card['__list_pos'], card['pos']] }

    grouped = {
      'core' => [],
      'mvp' => []
    }

    summary = {
      'all' => { 'tasks' => 0, 'hours' => 0, 'price_usd' => 0 },
      'core' => { 'tasks' => 0, 'hours' => 0, 'price_usd' => 0 },
      'mvp' => { 'tasks' => 0, 'hours' => 0, 'price_usd' => 0 },
      'by_status' => {}
    }

    ACTIVE_LISTS.each do |list_name|
      summary['by_status'][normalize_status(list_name)] = { 'tasks' => 0, 'hours' => 0, 'price_usd' => 0 }
    end

    cards.each do |card|
      label_names = (card['idLabels'] || []).map { |id| label_name_by_id[id] }.compact
      stage = STAGES.find { |name| label_names.include?(name) } || stage_from_desc(card['desc'])
      next unless stage

      layer = LAYERS.find { |name| label_names.include?(name) } || layer_from_name(card['name'])
      summary_text = summary_from_desc(card['desc'])
      hours = hours_from_desc(card['desc'])
      price = price_from_desc(card['desc'])
      status_key = normalize_status(card['__list_name'])

      task_entry = {
        'status' => card['__list_name'],
        'layer' => layer,
        'task' => card['name'],
        'hours' => hours,
        'price_usd' => price,
        'description' => summary_text
      }

      stage_key = stage.downcase
      grouped[stage_key] << task_entry
      summary['all']['tasks'] += 1
      summary['all']['hours'] += hours
      summary['all']['price_usd'] += price
      summary[stage_key]['tasks'] += 1
      summary[stage_key]['hours'] += hours
      summary[stage_key]['price_usd'] += price
      summary['by_status'][status_key]['tasks'] += 1
      summary['by_status'][status_key]['hours'] += hours
      summary['by_status'][status_key]['price_usd'] += price
    end

    payload = {
      'meta' => {
        'project' => board['name'],
        'board_id' => board['id'],
        'board_url' => board['url'],
        'source_lists' => ACTIVE_LISTS,
        'currency' => 'USD',
        'exported_at' => Time.now.iso8601,
        'summary' => summary
      },
      'core' => grouped['core'],
      'mvp' => grouped['mvp']
    }

    File.write(@options.fetch(:output_path), YAML.dump(payload))
    payload
  end

  private

  def normalize_status(name)
    name.downcase.gsub(/\s+/, '_')
  end

  def layer_from_name(name)
    name.to_s.split('|').first.to_s.strip
  end

  def summary_from_desc(desc)
    text = desc.to_s
    block = text.split(/\n\nEstimate\n/, 2).first.to_s
    block.sub(/\ASummary\n/, '').strip
  end

  def stage_from_desc(desc)
    line = desc.to_s.each_line.find { |item| item.start_with?('- Stage:') }
    line.to_s.split(':', 2).last.to_s.strip
  end

  def hours_from_desc(desc)
    line = desc.to_s.each_line.find { |item| item.start_with?('- Hours:') }
    line.to_s.split(':', 2).last.to_s.strip.delete('h').to_i
  end

  def price_from_desc(desc)
    line = desc.to_s.each_line.find { |item| item.start_with?('- Price:') }
    line.to_s.split(':', 2).last.to_s.strip.split.last.to_i
  end

  def request(method, path, params = {})
    uri = URI.parse("https://api.trello.com/1#{path}")
    uri.query = URI.encode_www_form({ key: @key, token: @token }.merge(params))
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = true

    req = case method
          when :get then Net::HTTP::Get.new(uri)
          else raise "Unsupported method: #{method}"
          end

    response = http.request(req)
    body = sanitize_string(response.body.to_s)
    log_http(method, uri.to_s, response.code.to_i, body)
    raise "HTTP #{response.code}: #{body}" unless response.is_a?(Net::HTTPSuccess)

    body.empty? ? {} : JSON.parse(body)
  end

  def log_http(method, url, body_code, response_body)
    File.open(@log_path, 'a') do |file|
      file.puts(JSON.generate(sanitize_value({
        ts: Time.now.iso8601,
        method: method.to_s.upcase,
        url: url.gsub(@key, '[REDACTED_KEY]').gsub(@token, '[REDACTED_TOKEN]'),
        status: body_code,
        response_body: response_body
      })))
    end
  end

  def sanitize_value(value)
    case value
    when String
      sanitize_string(value)
    when Array
      value.map { |item| sanitize_value(item) }
    when Hash
      value.each_with_object({}) do |(key, item), acc|
        acc[sanitize_value(key)] = sanitize_value(item)
      end
    else
      value
    end
  end

  def sanitize_string(value)
    value.to_s.dup.force_encoding('UTF-8').encode('UTF-8', invalid: :replace, undef: :replace, replace: '')
  end
end

options = {
  output_path: File.expand_path('trello_active_tasks_current.yaml', __dir__),
  log_path: File.expand_path("logs/trello-export-#{Time.now.strftime('%Y%m%d-%H%M%S')}.jsonl", __dir__)
}

OptionParser.new do |parser|
  parser.on('--board-id VALUE') { |value| options[:board_id] = value }
  parser.on('--key VALUE') { |value| options[:key] = value }
  parser.on('--token VALUE') { |value| options[:token] = value }
  parser.on('--out VALUE') { |value| options[:output_path] = File.expand_path(value) }
  parser.on('--log VALUE') { |value| options[:log_path] = File.expand_path(value) }
end.parse!

required = %i[board_id key token]
missing = required.reject { |key| options[key] && !options[key].to_s.empty? }
abort("Missing required options: #{missing.join(', ')}") unless missing.empty?

payload = TrelloActiveTasksExporter.new(options).run
puts JSON.pretty_generate({
  output_path: options[:output_path],
  totals: payload['meta']['summary']
})
